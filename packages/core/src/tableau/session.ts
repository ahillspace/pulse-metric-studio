import crypto from 'node:crypto';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../db/crypto.js';
import {
  createCredentialBrokerClient,
  type CredentialBrokerClient,
} from './credential-broker.js';
import type { TableauSession } from './rest-client.js';
import type { TableauGroupCreationAccess } from '@pulse-metric-studio/shared';

/**
 * Connection profiles contain Tableau coordinates and a credential location.
 * OS-managed profiles store only a credential reference. Browser development
 * can use the app-encrypted fallback after the user explicitly selects it.
 */

export type CredentialStorageKind = 'os' | 'encrypted';

export interface ConnectionProfile {
  id: string;
  label: string;
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  storageKind: CredentialStorageKind;
  credentialRef: string | null;
}

export interface StoredConnection extends ConnectionProfile {
  patSecretEnc: string;
  createdAt: number;
}

interface StoredRow {
  id: string;
  label: string;
  server_url: string;
  site_content_url: string;
  pat_name: string;
  pat_secret_enc: string;
  credential_ref: string | null;
  storage_kind: string;
  created_at: number;
  last_used_at: number | null;
}

export type SaveConnectionInput = {
  id?: string;
  label: string;
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
} & (
  | { storageKind: 'os'; credentialRef: string }
  | { storageKind: 'encrypted'; patSecret: string }
);

export type ReplaceConnectionCredentialInput =
  | { storageKind: 'os'; credentialRef: string; patName?: string }
  | { storageKind: 'encrypted'; patSecret: string; patName?: string };

export class StoredCredentialError extends Error {
  constructor(
    public readonly code:
      | 'invalid_storage_kind'
      | 'missing_credential_ref'
      | 'missing_encrypted_secret'
      | 'unreadable_encrypted_secret',
    message: string,
  ) {
    super(message);
    this.name = 'StoredCredentialError';
  }
}

function mapRow(row: StoredRow): StoredConnection {
  if (row.storage_kind !== 'os' && row.storage_kind !== 'encrypted') {
    throw new StoredCredentialError(
      'invalid_storage_kind',
      'The saved connection has an unsupported credential storage kind.',
    );
  }
  const storageKind = row.storage_kind;
  return {
    id: row.id,
    label: row.label,
    serverUrl: row.server_url,
    siteContentUrl: row.site_content_url,
    patName: row.pat_name,
    patSecretEnc: row.pat_secret_enc,
    credentialRef: row.credential_ref,
    storageKind,
    createdAt: row.created_at,
  };
}

function publicProfile(connection: StoredConnection): ConnectionProfile {
  return {
    id: connection.id,
    label: connection.label,
    serverUrl: connection.serverUrl,
    siteContentUrl: connection.siteContentUrl,
    patName: connection.patName,
    storageKind: connection.storageKind,
    credentialRef: connection.credentialRef,
  };
}

const db = () => getDb();

let activeSession: TableauSession | null = null;
let sessionGeneration = 0;
export interface TableauSessionContext {
  readonly connectionId: string;
  readonly generation: number;
  readonly serverUrl: string;
  readonly siteContentUrl: string;
  readonly siteId: string;
}
const sessionContexts = new WeakMap<TableauSession, TableauSessionContext>();
interface UserAccessFacts {
  context: TableauSessionContext | null;
  serverUrl: string;
  siteId: string;
  userId: string;
  siteRole?: string;
  checkedAt: number;
  verified: boolean;
  profileUnavailable?: boolean;
}
const userAccess = new WeakMap<TableauSession, UserAccessFacts>();
export interface TableauUserAccessCheck {
  readonly context: TableauSessionContext | null;
  readonly generation: number;
}
const userAccessChecks = new WeakMap<TableauSession, TableauUserAccessCheck>();

/** Only the newest dispatched own-user read may update this session's facts. */
export function beginTableauUserAccessCheck(session: TableauSession): TableauUserAccessCheck {
  const check = Object.freeze({ context: getSessionContext(session), generation: getSessionGeneration() });
  userAccessChecks.set(session, check);
  return check;
}

export function isTableauUserAccessCheckCurrent(session: TableauSession, check: TableauUserAccessCheck): boolean {
  return userAccessChecks.get(session) === check && check.generation === getSessionGeneration()
    && check.context === getSessionContext(session) && (!check.context || isSessionCurrent(session));
}

/** Permission metadata is evidence about this authenticated user, never a decoded PAT. */
export function captureTableauUserAccess(session: TableauSession, payload: unknown): boolean {
  const user = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { user?: unknown }).user : null;
  const record = user && typeof user === 'object' && !Array.isArray(user)
    ? user as { id?: unknown; luid?: unknown; siteRole?: unknown } : null;
  const id = record?.id ?? record?.luid;
  const matched = typeof id === 'string' && id === session.userId
    && !(record?.id && record?.luid && record.id !== record.luid);
  const role = matched && typeof record?.siteRole === 'string' && /^[a-z][a-z0-9_-]{0,79}$/i.test(record.siteRole)
    ? record.siteRole : undefined;
  if (role) session.siteRole = role;
  else delete session.siteRole;
  userAccess.set(session, {
    context: getSessionContext(session), serverUrl: session.serverUrl, siteId: session.siteId,
    userId: session.userId, ...(role ? { siteRole: role } : {}), checkedAt: Date.now(), verified: matched,
  });
  return matched;
}

export function markTableauUserAccessUnavailable(session: TableauSession, profileUnavailable = false): void {
  captureTableauUserAccess(session, null);
  const facts = userAccess.get(session);
  if (facts && profileUnavailable) facts.profileUnavailable = true;
}

/** Availability is advisory; the provider still authorizes every actual write. */
export function getGroupCreationAccess(session: TableauSession): TableauGroupCreationAccess {
  const unknown = (reasonCode: string, message: string, checkedAt?: number): TableauGroupCreationAccess => ({
    state: 'unknown', reasonCode, message, ...(checkedAt !== undefined ? { checkedAt } : {}),
  });
  const context = getSessionContext(session);
  if (!context || !isSessionCurrent(session)) return unknown('session_changed', 'Reconnect to verify group creation access for the current Tableau account.');
  const facts = userAccess.get(session);
  if (facts && facts.context === context && facts.serverUrl === session.serverUrl && facts.siteId === session.siteId && facts.userId === session.userId && facts.profileUnavailable) {
    return unknown('user_profile_unavailable', 'Tableau did not return this account profile. Group creation access is unknown; choose Follow Me or contact your administrator.', facts.checkedAt);
  }
  if (!facts || facts.context !== context || facts.serverUrl !== session.serverUrl || facts.siteId !== session.siteId || facts.userId !== session.userId || !facts.verified) {
    return unknown('user_access_unverified', 'Group creation access could not be verified. Retry the permission check, or choose Follow Me.', facts?.checkedAt);
  }
  if (!facts.siteRole) return unknown('site_role_unavailable', 'Tableau did not return a site role. Retry the permission check, or choose Follow Me.', facts.checkedAt);
  if (['ServerAdministrator', 'SiteAdministratorCreator', 'SiteAdministratorExplorer'].includes(facts.siteRole)) {
    return { state: 'allowed', reasonCode: 'administrator_role', message: 'This Tableau account has an administrator role for group creation.', checkedAt: facts.checkedAt };
  }
  const hostname = new URL(session.serverUrl).hostname.toLowerCase();
  if (hostname !== 'online.tableau.com' && !hostname.endsWith('.online.tableau.com')) {
    return unknown('server_permissions_unverified', 'Group creation access cannot be inferred from this Tableau Server role because delegated permissions can differ. Choose Follow Me or contact your administrator.', facts.checkedAt);
  }
  if (['Creator', 'ExplorerCanPublish', 'Explorer', 'Viewer', 'ReadOnly', 'Unlicensed'].includes(facts.siteRole)) {
    return { state: 'denied', reasonCode: 'site_role_cannot_create_groups', message: 'Creating a Tableau Cloud group requires a site administrator. Choose Follow Me to follow metrics without creating a group.', checkedAt: facts.checkedAt };
  }
  return unknown('site_role_unknown', 'This Tableau site role does not establish group creation access. Choose Follow Me or contact your administrator.', facts.checkedAt);
}

export function getSessionGeneration(): number {
  return sessionGeneration;
}

export function getSessionContext(session: TableauSession): TableauSessionContext | null {
  return sessionContexts.get(session) ?? null;
}

export function isSessionCurrent(session: TableauSession): boolean {
  const context = getSessionContext(session);
  return activeSession === session && context?.generation === sessionGeneration
    && context.serverUrl === session.serverUrl && context.siteContentUrl === session.siteContentUrl
    && context.siteId === session.siteId;
}
let activeCredential: { connectionId: string; patSecret: string } | null = null;

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (url.protocol !== 'https:') throw new Error('Server URL must use https');
  return url.origin;
}

export function saveConnection(input: SaveConnectionInput): ConnectionProfile {
  const id = input.id?.trim() || crypto.randomUUID();
  const credentialRef = input.storageKind === 'os' ? requiredCredentialRef(input.credentialRef) : null;
  const patSecretEnc = input.storageKind === 'encrypted'
    ? encryptSecret(requiredPatSecret(input.patSecret))
    : '';
  const database = db();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO connections (
         id, label, server_url, site_content_url, pat_name, pat_secret_enc,
         credential_ref, storage_kind, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.label,
      input.serverUrl,
      input.siteContentUrl,
      input.patName,
      patSecretEnc,
      credentialRef,
      input.storageKind,
      Date.now(),
    );
    if (!setActiveConnection(id)) throw new Error('Saved Tableau connection could not be activated.');
  })();
  return {
    id,
    label: input.label,
    serverUrl: input.serverUrl,
    siteContentUrl: input.siteContentUrl,
    patName: input.patName,
    storageKind: input.storageKind,
    credentialRef,
  };
}

export function listConnections(): Array<ConnectionProfile & { isActive: boolean }> {
  const rows = db().prepare('SELECT * FROM connections ORDER BY created_at DESC').all() as unknown as StoredRow[];
  const activeId = getSetting(db(), 'activeConnectionId');
  return rows.map((row) => {
    const profile = publicProfile(mapRow(row));
    return { ...profile, isActive: profile.id === activeId };
  });
}

export function getStoredConnection(id?: string): (StoredConnection & { patSecret: string }) | null {
  const row = (
    id
      ? db().prepare('SELECT * FROM connections WHERE id = ?').get(id)
      : (() => {
          const activeId = getSetting(db(), 'activeConnectionId');
          return activeId ? db().prepare('SELECT * FROM connections WHERE id = ?').get(activeId) : undefined;
        })()
  ) as StoredRow | undefined;
  if (!row) return null;
  const connection = mapRow(row) as StoredConnection & { patSecret: string };
  Object.defineProperty(connection, 'patSecret', {
    enumerable: false,
    get(): string {
      if (connection.storageKind === 'encrypted') {
        if (!connection.patSecretEnc) {
          throw new StoredCredentialError(
            'missing_encrypted_secret',
            'The saved encrypted fallback credential is missing.',
          );
        }
        return decryptStoredSecret(connection.patSecretEnc);
      }
      if (activeCredential?.connectionId === connection.id) return activeCredential.patSecret;
      throw new StoredCredentialError(
        'missing_credential_ref',
        'The OS credential must be retrieved before Tableau sign-in.',
      );
    },
  });
  return connection;
}

export async function resolveConnectionSecret(
  connection: StoredConnection,
  broker: CredentialBrokerClient = createCredentialBrokerClient(),
): Promise<string> {
  if (connection.storageKind === 'os') {
    if (!connection.credentialRef) {
      throw new StoredCredentialError(
        'missing_credential_ref',
        'The saved connection has no OS credential reference.',
      );
    }
    return broker.resolve(connection.credentialRef);
  }

  if (!connection.patSecretEnc) {
    throw new StoredCredentialError(
      'missing_encrypted_secret',
      'The saved encrypted fallback credential is missing.',
    );
  }
  return decryptStoredSecret(connection.patSecretEnc);
}

function updateConnectionCredential(
  id: string,
  input: ReplaceConnectionCredentialInput,
): ConnectionProfile | null {
  const existing = getStoredConnection(id);
  if (!existing) return null;
  const credentialRef = input.storageKind === 'os' ? requiredCredentialRef(input.credentialRef) : null;
  const patSecretEnc = input.storageKind === 'encrypted'
    ? encryptSecret(requiredPatSecret(input.patSecret))
    : '';
  db().prepare(
    `UPDATE connections
     SET pat_name = ?, pat_secret_enc = ?, credential_ref = ?, storage_kind = ?
     WHERE id = ?`,
  ).run(input.patName?.trim() || existing.patName, patSecretEnc, credentialRef, input.storageKind, id);
  return publicProfile(getStoredConnection(id)!);
}

function invalidateReplacedCredential(id: string): void {
  if (activeSession && getSessionContext(activeSession)?.connectionId === id) clearSession();
  else if (activeCredential?.connectionId === id) activeCredential = null;
}

export function replaceConnectionCredential(id: string, input: ReplaceConnectionCredentialInput): ConnectionProfile | null {
  const profile = updateConnectionCredential(id, input);
  if (profile) invalidateReplacedCredential(id);
  return profile;
}

type CredentialRetirement = { ticket: string; operationId: string; connectionId: string; oldRef: string; newRef: string | null; state: 'pending' | 'removed' };
const RETIREMENT_PREFIX = 'tableauCredentialRetirement:';

export function credentialRetirements(): CredentialRetirement[] {
  const rows = db().prepare('SELECT value FROM settings WHERE key LIKE ?').all(`${RETIREMENT_PREFIX}%`) as Array<{ value: string }>;
  return rows.map(row => JSON.parse(row.value) as CredentialRetirement);
}

export function credentialRetirement(ticket: string): CredentialRetirement | undefined {
  const value = getSetting(db(), RETIREMENT_PREFIX + ticket);
  return value ? JSON.parse(value) as CredentialRetirement : undefined;
}

export function markCredentialRetired(record: CredentialRetirement): void {
  setSetting(db(), RETIREMENT_PREFIX + record.ticket, JSON.stringify({ ...record, state: 'removed' }));
}

export function replaceCredentialWithRetirement(id: string, input: ReplaceConnectionCredentialInput, operationId: string): { profile: ConnectionProfile; retirement?: { ticket: string } } | null {
  const result = db().transaction(() => {
    const previous = getStoredConnection(id);
    if (!previous) return null;
    const profile = updateConnectionCredential(id, input);
    if (!profile) return null;
    const oldRef = previous.storageKind === 'os' ? previous.credentialRef : null;
    if (!oldRef || oldRef === profile.credentialRef) return { profile };
    const ticket = crypto.randomUUID();
    const record: CredentialRetirement = { ticket, operationId, connectionId: id, oldRef, newRef: profile.credentialRef, state: 'pending' };
    setSetting(db(), RETIREMENT_PREFIX + ticket, JSON.stringify(record));
    return { profile, retirement: { ticket } };
  })();
  if (result) invalidateReplacedCredential(id);
  return result;
}

export function setActiveConnection(id: string): boolean {
  const exists = db().prepare('SELECT 1 FROM connections WHERE id = ?').get(id);
  if (!exists) return false;
  if (getSetting(db(), 'activeConnectionId') !== id) clearSession();
  setSetting(db(), 'activeConnectionId', id);
  db().prepare('UPDATE connections SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  return true;
}

export function deleteConnection(id: string): ConnectionProfile | null {
  const existing = getStoredConnection(id);
  if (!existing) return null;
  db().prepare('DELETE FROM connections WHERE id = ?').run(id);
  if (getSetting(db(), 'activeConnectionId') === id) {
    setSetting(db(), 'activeConnectionId', '');
    clearSession();
  }
  return publicProfile(existing);
}

export function getSession(): TableauSession | null {
  return activeSession;
}

export function setSession(
  session: TableauSession,
  credential?: { connectionId: string; patSecret: string },
): void {
  const connectionId = credential?.connectionId ?? getSetting(db(), 'activeConnectionId');
  const connection = connectionId ? getStoredConnection(connectionId) : null;
  if (connection && (connection.serverUrl !== session.serverUrl || connection.siteContentUrl !== session.siteContentUrl)) {
    throw new Error('Tableau session does not match its connection.');
  }
  sessionGeneration++;
  if (connectionId) sessionContexts.set(session, Object.freeze({
    connectionId, generation: sessionGeneration, serverUrl: session.serverUrl,
    siteContentUrl: session.siteContentUrl, siteId: session.siteId,
  }));
  const facts = userAccess.get(session);
  if (facts && facts.context === null && facts.serverUrl === session.serverUrl && facts.siteId === session.siteId && facts.userId === session.userId) {
    facts.context = getSessionContext(session);
  } else {
    userAccess.delete(session);
    delete session.siteRole;
  }
  activeSession = session;
  activeCredential = credential ?? null;
}

export function clearSession(): void {
  sessionGeneration++;
  activeSession = null;
  activeCredential = null;
}

function requiredCredentialRef(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('credentialRef is required for OS credential storage');
  return normalized;
}

function requiredPatSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('patSecret is required for encrypted fallback storage');
  return normalized;
}

function decryptStoredSecret(value: string): string {
  try {
    return decryptSecret(value);
  } catch {
    throw new StoredCredentialError(
      'unreadable_encrypted_secret',
      'The saved encrypted fallback credential cannot be read.',
    );
  }
}
