import '@fastify/sensible';
import type { FastifyInstance } from 'fastify';
import {
  createCredentialBrokerClient,
  CredentialBrokerError,
  type CredentialBrokerClient,
} from './credential-broker.js';
import { apiPath, TableauError, type TableauSession } from './rest-client.js';
import { invalidateFieldsCache, listDatasources } from './vds-fields.js';
import { discoverRestApiVersion, patSignin } from './signin.js';
import {
  clearSession,
  deleteConnection,
  getStoredConnection,
  getSession,
  getSessionContext,
  getSessionGeneration,
  isSessionCurrent,
  listConnections,
  normalizeServerUrl,
  replaceConnectionCredential,
  resolveConnectionSecret,
  saveConnection,
  setActiveConnection,
  setSession,
  StoredCredentialError,
  type CredentialStorageKind,
  type ConnectionProfile,
  type StoredConnection,
} from './session.js';

export interface TableauRouteDependencies {
  credentialBroker?: CredentialBrokerClient;
  discoverRestApiVersion?: typeof discoverRestApiVersion;
  patSignin?: typeof patSignin;
  fetchImpl?: typeof fetch;
}

type CredentialInput = {
  storageKind?: CredentialStorageKind;
  credentialRef?: string;
  patSecret?: string;
  explicitFallback?: boolean;
};

type ConnectInput = CredentialInput & {
  operationId?: string;
  serverUrl?: string;
  siteContentUrl?: string;
  patName?: string;
  label?: string;
};

type CredentialReconciliationInput = {
  operationId?: string;
  kind?: string;
  connectionId?: string;
  credentialRef?: string;
};

/** Register connection and datasource routes without exposing PAT values. */
export function registerTableauRoutes(
  app: FastifyInstance,
  dependencies: TableauRouteDependencies = {},
): void {
  const broker = dependencies.credentialBroker ?? createCredentialBrokerClient();
  const discoverVersion = dependencies.discoverRestApiVersion ?? discoverRestApiVersion;
  const signIn = dependencies.patSignin ?? patSignin;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const pendingCredentialMutations = new Map<string, PendingCredentialMutation>();
  const pendingActivations = new Map<string, Promise<TableauSession>>();

  async function activateConnection(stored: StoredConnection): Promise<TableauSession> {
    const key = JSON.stringify([getSessionGeneration(), stored.id]);
    const pending = pendingActivations.get(key);
    if (pending) return pending;
    const promise = activateStoredConnection(stored, broker, discoverVersion, signIn, fetchImpl);
    pendingActivations.set(key, promise);
    try { return await promise; }
    finally { if (pendingActivations.get(key) === promise) pendingActivations.delete(key); }
  }

  app.post('/api/tableau/connect', async (req) => {
    const body = req.body as ConnectInput;
    const operationId = parseOperationId(app, body.operationId);
    const coordinates = parseCoordinates(app, body);
    const fingerprint = credentialMutationFingerprint('connect', operationId, body, coordinates);

    return runCredentialMutation(app, pendingCredentialMutations, operationId, fingerprint, async () => {
      const generation = getSessionGeneration();
      const existing = getStoredConnection(operationId);
      if (existing) {
        if (!connectionMatchesCreateAttempt(existing, body, coordinates)) {
          throw app.httpErrors.conflict('The connection operation ID is already assigned to another request.');
        }
        return resumeCommittedCredentialMutation(
          app,
          publicConnection(operationId)!,
          body,
          coordinates,
          broker,
          discoverVersion,
          signIn,
          fetchImpl,
        );
      }

      const credential = await parseCredentialInput(app, body, broker);
      const session = await createTableauSession(coordinates, credential.patSecret, discoverVersion, signIn, fetchImpl);
      assertSessionGeneration(generation);
      let profile: ConnectionProfile;
      try {
        profile = saveConnection({
          id: operationId,
          label: body.label?.trim() || connectionLabel(coordinates.serverUrl, coordinates.siteContentUrl),
          ...coordinates,
          ...(credential.storageKind === 'os'
            ? { storageKind: 'os' as const, credentialRef: credential.credentialRef }
            : { storageKind: 'encrypted' as const, patSecret: credential.patSecret }),
        });
      } catch (saveError) {
        const committed = getStoredConnection(operationId);
        if (!committed || !connectionMatchesCreateAttempt(committed, body, coordinates)) throw saveError;
        profile = publicConnection(operationId)!;
      }
      setSession(session, { connectionId: profile.id, patSecret: credential.patSecret });

      return {
        ok: true as const,
        connection: profile,
        session: publicSession(session),
      };
    });
  });

  app.get('/api/tableau/status', async () => {
    const session = getSession();
    if (!session) {
      let stored: ReturnType<typeof getStoredConnection>;
      try {
        stored = getStoredConnection();
      } catch (error) {
        const restoreError = publicCredentialError(error);
        app.log.warn({ code: restoreError.code }, 'Stored Tableau connection could not be read');
        return { connected: false, hasStoredProfile: true, restoreError };
      }
      if (!stored) return { connected: false, hasStoredProfile: false };
      try {
        const restored = await activateConnection(stored);
        return {
          connected: true,
          restored: true,
          connectionId: stored.id,
          session: publicSession(restored),
        };
      } catch (error) {
        const restoreError = publicCredentialError(error);
        app.log.warn({ code: restoreError.code }, 'Stored Tableau connection could not be restored');
        return {
          connected: false,
          hasStoredProfile: true,
          connectionId: stored.id,
          restoreError,
        };
      }
    }

    try {
      const response = await fetchImpl(
        `${session.serverUrl}${apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/users/current`)}`,
        {
          headers: { 'X-Tableau-Auth': session.token, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      captureCurrentUserName(session, await response.json().catch(() => null));
      if (!isSessionCurrent(session)) return { connected: false, hasStoredProfile: getStoredConnection() != null };
      return { connected: true, restored: false, session: publicSession(session) };
    } catch {
      if (isSessionCurrent(session)) clearSession();
      return { connected: false, hasStoredProfile: getStoredConnection() != null };
    }
  });

  app.get('/api/tableau/connections', async () => ({ connections: listConnections() }));

  app.post('/api/tableau/connections/reconcile', async (req) => {
    const body = req.body as CredentialReconciliationInput;
    const operationId = parseOperationId(app, body.operationId);
    const credentialRef = body.credentialRef?.trim();
    if (!credentialRef) throw app.httpErrors.badRequest('credentialRef is required for reconciliation.');

    if (body.kind === 'connect') {
      const connection = publicConnection(operationId);
      if (connection?.storageKind === 'os' && connection.credentialRef === credentialRef) {
        return { status: 'committed' as const, connection };
      }
    } else if (body.kind === 'replace') {
      const connectionId = body.connectionId?.trim();
      if (!connectionId) throw app.httpErrors.badRequest('connectionId is required for replacement reconciliation.');
      const connection = publicConnection(connectionId);
      if (connection?.storageKind === 'os' && connection.credentialRef === credentialRef) {
        return { status: 'committed' as const, connection };
      }
    } else {
      throw app.httpErrors.badRequest('kind must be connect or replace.');
    }

    if (pendingCredentialMutations.has(operationId)) return { status: 'pending' as const };
    return { status: 'not_committed' as const };
  });

  app.post('/api/tableau/connections/:id/activate', async (req) => {
    const { id } = req.params as { id: string };
    const stored = getStoredConnection(id);
    if (!stored) throw app.httpErrors.notFound('Saved Tableau connection not found.');
    try {
      const session = await activateConnection(stored);
      return {
        ok: true,
        connectionId: stored.id,
        session: publicSession(session),
      };
    } catch (error) {
      throwCredentialAccessError(app, error);
    }
  });

  app.put('/api/tableau/connections/:id/credential', async (req) => {
    const { id } = req.params as { id: string };
    const stored = getStoredConnection(id);
    if (!stored) throw app.httpErrors.notFound('Saved Tableau connection not found.');
    const body = req.body as CredentialInput & { operationId?: string; patName?: string };
    const operationId = parseOperationId(app, body.operationId);
    const patName = body.patName?.trim() || stored.patName;
    const coordinates = { serverUrl: stored.serverUrl, siteContentUrl: stored.siteContentUrl, patName };
    const fingerprint = credentialMutationFingerprint('replace', operationId, body, coordinates, id);

    return runCredentialMutation(app, pendingCredentialMutations, operationId, fingerprint, async () => {
      const generation = getSessionGeneration();
      const current = getStoredConnection(id);
      if (!current) throw app.httpErrors.notFound('Saved Tableau connection not found.');
      if (connectionUsesRequestedOsCredential(current, body, patName)) {
        return resumeCommittedCredentialMutation(
          app,
          publicConnection(id)!,
          body,
          coordinates,
          broker,
          discoverVersion,
          signIn,
          fetchImpl,
        );
      }

      const credential = await parseCredentialInput(app, body, broker);
      const session = await createTableauSession(coordinates, credential.patSecret, discoverVersion, signIn, fetchImpl);
      assertSessionGeneration(generation);
      const profile = replaceConnectionCredential(id, {
        patName,
        ...(credential.storageKind === 'os'
          ? { storageKind: 'os' as const, credentialRef: credential.credentialRef }
          : { storageKind: 'encrypted' as const, patSecret: credential.patSecret }),
      });
      if (!profile) throw app.httpErrors.notFound('Saved Tableau connection not found.');
      const activated = setActiveConnection(id);
      if (activated) setSession(session, { connectionId: id, patSecret: credential.patSecret });
      return {
        ok: true as const,
        connection: profile,
        session: activated ? publicSession(session) : null,
        ...(!activated ? { activationError: activationUnavailable() } : {}),
      };
    });
  });

  app.delete('/api/tableau/connections/:id', async (req) => {
    const { id } = req.params as { id: string };
    const stored = getStoredConnection(id);
    if (!stored) throw app.httpErrors.notFound('Saved Tableau connection not found.');
    const { credentialDisposition } = req.query as { credentialDisposition?: string };
    if (stored.storageKind === 'os' && !['removed', 'retained'].includes(credentialDisposition ?? '')) {
      throw app.httpErrors.badRequest(
        'credentialDisposition must be removed or retained for an OS-managed credential.',
      );
    }
    if (stored.storageKind === 'encrypted' && credentialDisposition !== 'database') {
      throw app.httpErrors.badRequest(
        'credentialDisposition must be database for an encrypted fallback credential.',
      );
    }
    deleteConnection(id);
    return { ok: true, credentialDisposition };
  });

  app.post('/api/tableau/disconnect', async (req) => {
    const body = req.body as { connectionId?: unknown; sessionGeneration?: unknown } | null;
    if (typeof body?.connectionId !== 'string' || !body.connectionId.trim()
      || !Number.isSafeInteger(body.sessionGeneration) || Number(body.sessionGeneration) < 0) {
      throw app.httpErrors.badRequest('connectionId and sessionGeneration are required to disconnect.');
    }
    const active = getSession();
    const connectionId = active ? getSessionContext(active)?.connectionId : getStoredConnection()?.id;
    if (body.connectionId !== connectionId || body.sessionGeneration !== getSessionGeneration()) {
      throw app.httpErrors.conflict('The Tableau connection changed. The newer session was not disconnected.');
    }
    clearSession();
    return { ok: true };
  });

  app.get('/api/datasources', async () => {
    const session = requireSession();
    try {
      const datasources = await listDatasources(session);
      return { datasources };
    } catch (error) {
      app.log.warn({ err: error }, 'listDatasources failed');
      throw error;
    }
  });

  app.get('/api/datasources/:luid/fields', async (req) => {
    const session = requireSession();
    const { luid } = req.params as { luid: string };
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    if (refresh) invalidateFieldsCache(luid);
    return { catalog: await import('./vds-fields.js').then((module) => module.getFieldCatalog(session, luid)) };
  });

  function requireSession(): TableauSession {
    const session = getSession();
    if (!session) throw app.httpErrors.unauthorized('Not connected to Tableau');
    return session;
  }
}

type CredentialMutationResponse = {
  ok: true;
  connection: ConnectionProfile;
  session: ReturnType<typeof publicSession> | null;
  activationError?: ReturnType<typeof activationUnavailable>;
};

type PendingCredentialMutation = {
  fingerprint: string;
  promise: Promise<CredentialMutationResponse>;
};

async function runCredentialMutation(
  app: FastifyInstance,
  pendingMutations: Map<string, PendingCredentialMutation>,
  operationId: string,
  fingerprint: string,
  mutation: () => Promise<CredentialMutationResponse>,
): Promise<CredentialMutationResponse> {
  const pending = pendingMutations.get(operationId);
  if (pending) {
    if (pending.fingerprint !== fingerprint) {
      throw app.httpErrors.conflict('The connection operation ID is already assigned to another request.');
    }
    return pending.promise;
  }

  const promise = mutation();
  pendingMutations.set(operationId, { fingerprint, promise });
  try {
    return await promise;
  } finally {
    if (pendingMutations.get(operationId)?.promise === promise) pendingMutations.delete(operationId);
  }
}

function parseOperationId(app: FastifyInstance, value: string | undefined): string {
  const operationId = value?.trim();
  if (!operationId || !UUID_PATTERN.test(operationId)) {
    throw app.httpErrors.badRequest('operationId must be a UUID.');
  }
  return operationId.toLowerCase();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function credentialMutationFingerprint(
  kind: 'connect' | 'replace',
  operationId: string,
  body: CredentialInput & { label?: string; patName?: string },
  coordinates: { serverUrl: string; siteContentUrl: string; patName: string },
  connectionId?: string,
): string {
  return JSON.stringify({
    kind,
    operationId,
    connectionId: connectionId ?? null,
    serverUrl: coordinates.serverUrl,
    siteContentUrl: coordinates.siteContentUrl,
    patName: coordinates.patName,
    label: kind === 'connect' ? body.label?.trim() || null : null,
    storageKind: body.storageKind ?? null,
    credentialRef: body.storageKind === 'os' ? body.credentialRef?.trim() ?? null : null,
    explicitFallback: body.storageKind === 'encrypted' ? body.explicitFallback === true : null,
  });
}

function connectionMatchesCreateAttempt(
  connection: StoredConnection,
  body: CredentialInput,
  coordinates: { serverUrl: string; siteContentUrl: string; patName: string },
): boolean {
  return connection.serverUrl === coordinates.serverUrl
    && connection.siteContentUrl === coordinates.siteContentUrl
    && connection.patName === coordinates.patName
    && connection.storageKind === body.storageKind
    && (body.storageKind !== 'os' || connection.credentialRef === body.credentialRef?.trim());
}

function connectionUsesRequestedOsCredential(
  connection: StoredConnection,
  body: CredentialInput,
  patName: string,
): boolean {
  return body.storageKind === 'os'
    && connection.storageKind === 'os'
    && connection.credentialRef === body.credentialRef?.trim()
    && connection.patName === patName;
}

function publicConnection(id: string): ConnectionProfile | null {
  const connection = listConnections().find((candidate) => candidate.id === id);
  if (!connection) return null;
  const { isActive: _isActive, ...profile } = connection;
  return profile;
}

async function resumeCommittedCredentialMutation(
  app: FastifyInstance,
  connection: ConnectionProfile,
  body: CredentialInput,
  coordinates: { serverUrl: string; siteContentUrl: string; patName: string },
  broker: CredentialBrokerClient,
  discoverVersion: typeof discoverRestApiVersion,
  signIn: typeof patSignin,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialMutationResponse> {
  const generation = getSessionGeneration();
  try {
    const credential = await parseCredentialInput(app, body, broker);
    const session = await createTableauSession(coordinates, credential.patSecret, discoverVersion, signIn, fetchImpl);
    assertSessionGeneration(generation);
    if (!setActiveConnection(connection.id)) {
      return { ok: true, connection, session: null, activationError: activationUnavailable() };
    }
    setSession(session, { connectionId: connection.id, patSecret: credential.patSecret });
    return { ok: true, connection, session: publicSession(session) };
  } catch {
    return { ok: true, connection, session: null, activationError: activationUnavailable() };
  }
}

function activationUnavailable(): {
  code: 'activation_unavailable';
  message: string;
} {
  return {
    code: 'activation_unavailable',
    message: 'The connection was saved, but Tableau activation could not be confirmed. Use the saved connection to retry.',
  };
}

async function parseCredentialInput(
  app: FastifyInstance,
  input: CredentialInput,
  broker: CredentialBrokerClient,
): Promise<
  | { storageKind: 'os'; credentialRef: string; patSecret: string }
  | { storageKind: 'encrypted'; patSecret: string }
> {
  if (input.storageKind === 'os') {
    if (input.patSecret !== undefined) {
      throw app.httpErrors.badRequest('OS-managed connection requests must not contain a PAT secret.');
    }
    const credentialRef = input.credentialRef?.trim();
    if (!credentialRef) throw app.httpErrors.badRequest('credentialRef is required for OS credential storage.');
    try {
      return { storageKind: 'os', credentialRef, patSecret: await broker.resolve(credentialRef) };
    } catch (error) {
      throwCredentialAccessError(app, error);
    }
  }

  if (input.storageKind === 'encrypted') {
    if (input.explicitFallback !== true) {
      throw app.httpErrors.badRequest('Encrypted credential storage requires explicitFallback=true.');
    }
    const patSecret = input.patSecret?.trim();
    if (!patSecret) throw app.httpErrors.badRequest('patSecret is required for encrypted fallback storage.');
    if (input.credentialRef !== undefined) {
      throw app.httpErrors.badRequest('Encrypted fallback requests must not contain credentialRef.');
    }
    return { storageKind: 'encrypted', patSecret };
  }

  throw app.httpErrors.badRequest('storageKind must be os or encrypted.');
}

function parseCoordinates(
  app: FastifyInstance,
  body: ConnectInput,
): { serverUrl: string; siteContentUrl: string; patName: string } {
  if (!body.serverUrl || !body.patName) {
    throw app.httpErrors.badRequest('serverUrl and patName are required.');
  }
  let serverUrl: string;
  try {
    serverUrl = normalizeServerUrl(body.serverUrl);
  } catch (error) {
    throw app.httpErrors.badRequest(`Invalid server URL: ${(error as Error).message}`);
  }
  return {
    serverUrl,
    siteContentUrl: (body.siteContentUrl ?? '').trim(),
    patName: body.patName.trim(),
  };
}

async function activateStoredConnection(
  stored: StoredConnection,
  broker: CredentialBrokerClient,
  discoverVersion: typeof discoverRestApiVersion,
  signIn: typeof patSignin,
  fetchImpl: typeof fetch = fetch,
): Promise<TableauSession> {
  const generation = getSessionGeneration();
  const patSecret = await resolveConnectionSecret(stored, broker);
  const session = await createTableauSession(stored, patSecret, discoverVersion, signIn, fetchImpl);
  assertSessionGeneration(generation);
  if (!setActiveConnection(stored.id)) throw new Error('Saved Tableau connection disappeared during activation.');
  setSession(session, { connectionId: stored.id, patSecret });
  return session;
}

function assertSessionGeneration(generation: number): void {
  if (generation !== getSessionGeneration()) {
    throw new TableauError('The Tableau connection changed during sign-in. Retry the connection.', 401, '', 'auth');
  }
}

async function createTableauSession(
  input: { serverUrl: string; siteContentUrl: string; patName: string },
  patSecret: string,
  discoverVersion: typeof discoverRestApiVersion,
  signIn: typeof patSignin,
  fetchImpl: typeof fetch = fetch,
): Promise<TableauSession> {
  const apiVersion = await discoverVersion(input.serverUrl);
  const signin = await signIn({ ...input, patSecret, apiVersion });
  const session: TableauSession = {
    serverUrl: input.serverUrl,
    siteContentUrl: input.siteContentUrl,
    siteId: signin.siteId,
    userId: signin.userId,
    token: signin.token,
    apiVersion,
  };
  // Sign-in does not return a display name, so resolve it here (best-effort).
  // This is the single funnel for connect/activate/replace/restore, so the
  // picker's "(you)" label reaches the real name on every path.
  await ensureCurrentUserName(session, fetchImpl);
  return session;
}

function throwCredentialAccessError(app: FastifyInstance, error: unknown): never {
  if (error instanceof CredentialBrokerError) {
    if (error.code === 'not_found') {
      throw app.httpErrors.conflict('The saved OS credential was not found. Replace or remove this connection.');
    }
    if (error.code === 'invalid_response') {
      throw app.httpErrors.failedDependency('The OS credential broker returned an invalid response.');
    }
    throw app.httpErrors.failedDependency(
      error.code === 'unauthorized'
        ? 'The OS credential broker rejected the server token.'
        : 'The OS credential broker is unavailable.',
    );
  }
  if (error instanceof StoredCredentialError) {
    throw app.httpErrors.conflict(`${error.message} Replace or remove this connection.`);
  }
  throw error;
}

function publicCredentialError(error: unknown): { code: string; message: string } {
  if (error instanceof CredentialBrokerError) {
    const code = error.code === 'not_found'
      ? 'credential_not_found'
      : error.code === 'unauthorized'
        ? 'credential_broker_unauthorized'
        : error.code === 'invalid_response'
          ? 'credential_broker_invalid_response'
          : 'credential_broker_unavailable';
    return { code, message: error.message };
  }
  if (error instanceof StoredCredentialError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'tableau_signin_failed', message: 'Tableau sign-in failed for the saved connection.' };
}

function connectionLabel(serverUrl: string, siteContentUrl: string): string {
  return `${serverUrl}${siteContentUrl ? ` / ${siteContentUrl}` : ''}`;
}

function publicSession(session: TableauSession) {
  const context = getSessionContext(session);
  if (!context) throw new Error('The Tableau session has no owning connection.');
  return {
    connectionId: context.connectionId,
    sessionGeneration: context.generation,
    serverUrl: session.serverUrl,
    siteContentUrl: session.siteContentUrl,
    siteId: session.siteId,
    userId: session.userId,
    ...(session.userName ? { userName: session.userName } : {}),
  };
}

/** Extract the current user's display name from a `/users/current` payload onto the session. */
function captureCurrentUserName(session: TableauSession, payload: unknown): void {
  if (session.userName) return;
  const user = payload && typeof payload === 'object' ? (payload as { user?: unknown }).user : undefined;
  if (!user || typeof user !== 'object') return;
  const { fullName, name } = user as { fullName?: unknown; name?: unknown };
  const resolved = typeof fullName === 'string' && fullName.trim()
    ? fullName.trim()
    : typeof name === 'string' && name.trim()
      ? name.trim()
      : undefined;
  if (resolved) session.userName = resolved;
}

/** Best-effort fetch of the current user's display name (used on connection restore). */
async function ensureCurrentUserName(
  session: TableauSession,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (session.userName) return;
  try {
    const response = await fetchImpl(
      `${session.serverUrl}${apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/users/current`)}`,
      {
        headers: { 'X-Tableau-Auth': session.token, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return;
    captureCurrentUserName(session, await response.json().catch(() => null));
  } catch {
    // display name is best-effort; the picker falls back to a generic "(you)" label
  }
}
