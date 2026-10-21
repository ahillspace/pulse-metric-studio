import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { desktopFetch } from './desktop-transport';
import type { TableauSessionInfo } from './api/client';
export type { TableauSessionInfo } from './api/client';
export type CredentialStorageKind = 'os' | 'encrypted';
export type CredentialPlatform = 'windows' | 'macos' | 'browser' | 'unsupported';

export interface ConnectionSummary {
  id: string;
  label: string;
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  storageKind: CredentialStorageKind;
  credentialRef: string | null;
  isActive: boolean;
}

export type SavedConnection = Omit<ConnectionSummary, 'isActive'>;

export interface CredentialCapability {
  available: boolean;
  platform: CredentialPlatform;
  actionLabel: string | null;
  reason?: string;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface NativeCapabilityResponse {
  available: boolean;
  platform: 'windows' | 'macos' | 'unsupported';
  reason?: string;
}

interface CredentialReferenceResponse {
  credentialRef: string;
}

interface TableauCoordinates {
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  label?: string;
}

export type ConnectRequest = TableauCoordinates & (
  | { storageKind: 'os'; credentialRef: string }
  | { storageKind: 'encrypted'; patSecret: string; explicitFallback: true }
);

export type ReplaceCredentialRequest = {
  patName?: string;
} & (
  | { storageKind: 'os'; credentialRef: string }
  | { storageKind: 'encrypted'; patSecret: string; explicitFallback: true }
);

export interface CredentialMutationResponse {
  ok: true;
  connection: SavedConnection;
  session: TableauSessionInfo | null;
  activationError?: {
    code: 'activation_unavailable';
    message: string;
  };
}

export class CredentialMutationError extends Error {
  constructor(
    message: string,
    public readonly serverConfirmedNotCommitted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CredentialMutationError';
  }
}

export function canCompensateStagedCredential(error: unknown): boolean {
  return error instanceof CredentialMutationError && error.serverConfirmedNotCommitted;
}

export function credentialActionLabel(platform: CredentialPlatform): string | null {
  if (platform === 'windows') return 'Add to Windows Credential Manager';
  if (platform === 'macos') return 'Add to macOS Keychain';
  return null;
}

export function restoredConnectionFields(connection: ConnectionSummary): TableauCoordinates {
  return {
    serverUrl: connection.serverUrl,
    siteContentUrl: connection.siteContentUrl,
    patName: connection.patName,
  };
}

export async function getCredentialCapability(invokeImpl?: Invoke): Promise<CredentialCapability> {
  if (!invokeImpl && !isTauriRuntime()) {
    return {
      available: false,
      platform: 'browser',
      actionLabel: null,
      reason: 'OS credential storage is available only in the desktop app.',
    };
  }
  try {
    const invoke = invokeImpl ?? await loadTauriInvoke();
    const response = await invoke<NativeCapabilityResponse>('tableau_credential_capability');
    const actionLabel = credentialActionLabel(response.platform);
    const available = response.available && actionLabel !== null;
    return {
      available,
      platform: response.platform,
      actionLabel: available ? actionLabel : null,
      reason: available ? response.reason : response.reason ?? 'OS credential storage is unavailable.',
    };
  } catch {
    return {
      available: false,
      platform: isTauriRuntime() ? 'unsupported' : 'browser',
      actionLabel: null,
      reason: 'OS credential storage is unavailable.',
    };
  }
}

export async function storeNativeCredential(
  input: TableauCoordinates & { patSecret: string },
  invokeImpl?: Invoke,
): Promise<string> {
  const invoke = invokeImpl ?? await loadTauriInvoke();
  const response = await invoke<CredentialReferenceResponse>('tableau_store_credential', {
    request: input,
  });
  return requiredCredentialRef(response);
}

export async function deleteNativeCredential(
  credentialRef: string,
  invokeImpl?: Invoke,
): Promise<void> {
  const invoke = invokeImpl ?? await loadTauriInvoke();
  const response = await invoke<{ removed: boolean }>('tableau_delete_credential', {
    request: { credentialRef },
  });
  if (!response.removed) throw new Error('Windows or macOS did not remove the saved credential.');
}

export function createTableauConnectionsApi(
  fetchImpl: typeof fetch = fetch,
  operationIdFactory: () => string = () => globalThis.crypto.randomUUID(),
) {
  return {
    async list(): Promise<ConnectionSummary[]> {
      const result = await request<{ connections: ConnectionSummary[] }>(fetchImpl, '/api/tableau/connections');
      return result.connections;
    },

    connect(input: ConnectRequest) {
      return requestCredentialMutation(
        fetchImpl,
        '/api/tableau/connect',
        'POST',
        { ...input, operationId: operationIdFactory() },
      );
    },

    activate(id: string) {
      return request<{ ok: true; connectionId: string; session: TableauSessionInfo }>(
        fetchImpl,
        `/api/tableau/connections/${encodeURIComponent(id)}/activate`,
        'POST',
      );
    },

    replaceCredential(id: string, input: ReplaceCredentialRequest) {
      return requestCredentialMutation(
        fetchImpl,
        `/api/tableau/connections/${encodeURIComponent(id)}/credential`,
        'PUT',
        { ...input, operationId: operationIdFactory() },
      );
    },

    delete(id: string, credentialDisposition: 'removed' | 'retained' | 'database') {
      const query = new URLSearchParams({ credentialDisposition });
      return request<{ ok: true; credentialDisposition: string }>(
        fetchImpl,
        `/api/tableau/connections/${encodeURIComponent(id)}?${query.toString()}`,
        'DELETE',
      );
    },
  };
}

export const tableauConnectionsApi = createTableauConnectionsApi((input, init) => desktopFetch(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init));

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: unknown; message?: unknown } | null)?.error
      ?? (data as { message?: unknown } | null)?.message
      ?? `Request failed (${response.status})`;
    throw new HttpResponseError(
      typeof message === 'string' ? message : `Request failed (${response.status})`,
      response.status,
    );
  }
  return data as T;
}

async function requestCredentialMutation(
  fetchImpl: typeof fetch,
  url: string,
  method: 'POST' | 'PUT',
  body: ConnectRequest & { operationId: string } | ReplaceCredentialRequest & { operationId: string },
): Promise<CredentialMutationResponse> {
  const reconciliation = credentialReconciliationRequest(url, body);
  try {
    return await sendCredentialMutation(fetchImpl, url, method, body);
  } catch (firstError) {
    if (firstError instanceof HttpResponseError) {
      return reconcileRejectedCredentialMutation(fetchImpl, reconciliation, firstError);
    }

    try {
      return await sendCredentialMutation(fetchImpl, url, method, body);
    } catch (reconciliationError) {
      if (reconciliationError instanceof HttpResponseError) {
        return reconcileRejectedCredentialMutation(fetchImpl, reconciliation, reconciliationError);
      }
      throw new CredentialMutationError(
        'The server did not confirm whether it saved the connection. The staged OS credential was retained to protect a possible committed connection.',
        false,
        { cause: reconciliationError },
      );
    }
  }
}

type CredentialReconciliationRequest = {
  operationId: string;
  kind: 'connect' | 'replace';
  connectionId?: string;
  credentialRef: string;
};

type CredentialReconciliationResponse =
  | { status: 'committed'; connection: SavedConnection }
  | { status: 'not_committed' | 'pending' };

function credentialReconciliationRequest(
  url: string,
  body: ConnectRequest & { operationId: string } | ReplaceCredentialRequest & { operationId: string },
): CredentialReconciliationRequest | null {
  if (body.storageKind !== 'os') return null;
  const replacementMatch = /^\/api\/tableau\/connections\/([^/]+)\/credential$/.exec(url);
  return {
    operationId: body.operationId,
    kind: replacementMatch ? 'replace' : 'connect',
    ...(replacementMatch ? { connectionId: decodeURIComponent(replacementMatch[1]) } : {}),
    credentialRef: body.credentialRef,
  };
}

async function reconcileRejectedCredentialMutation(
  fetchImpl: typeof fetch,
  reconciliation: CredentialReconciliationRequest | null,
  rejection: HttpResponseError,
): Promise<CredentialMutationResponse> {
  if (!reconciliation) throw confirmedMutationFailure(rejection);

  try {
    const result = await request<CredentialReconciliationResponse>(
      fetchImpl,
      '/api/tableau/connections/reconcile',
      'POST',
      reconciliation,
    );
    if (result.status === 'not_committed') throw confirmedMutationFailure(rejection);
    if (result.status === 'committed') {
      return {
        ok: true,
        connection: result.connection,
        session: null,
        activationError: {
          code: 'activation_unavailable',
          message: 'The connection was saved, but Tableau activation could not be confirmed. Use the saved connection to retry.',
        },
      };
    }
  } catch (statusError) {
    if (statusError instanceof CredentialMutationError) throw statusError;
  }

  throw new CredentialMutationError(
    'The server rejected the request but did not prove that the connection remained unchanged. The staged OS credential was retained.',
    false,
    { cause: rejection },
  );
}

async function sendCredentialMutation(
  fetchImpl: typeof fetch,
  url: string,
  method: 'POST' | 'PUT',
  body: ConnectRequest & { operationId: string } | ReplaceCredentialRequest & { operationId: string },
): Promise<CredentialMutationResponse> {
  const result = await request<unknown>(fetchImpl, url, method, body);
  if (!isCredentialMutationResponse(result)) {
    throw new Error('The server returned an invalid connection result.');
  }
  return result;
}

function isCredentialMutationResponse(value: unknown): value is CredentialMutationResponse {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<CredentialMutationResponse>;
  return result.ok === true
    && Boolean(result.connection && typeof result.connection.id === 'string')
    && (result.session === null || Boolean(result.session && typeof result.session.siteId === 'string'));
}

function confirmedMutationFailure(error: HttpResponseError): CredentialMutationError {
  return new CredentialMutationError(error.message, true, { cause: error });
}

class HttpResponseError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

function requiredCredentialRef(response: CredentialReferenceResponse): string {
  const credentialRef = response.credentialRef?.trim();
  if (!credentialRef) throw new Error('The OS credential store returned no credential reference.');
  return credentialRef;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadTauriInvoke(): Promise<Invoke> {
  if (!isTauriRuntime()) throw new Error('OS credential storage requires the desktop app.');
  return tauriInvoke as Invoke;
}
