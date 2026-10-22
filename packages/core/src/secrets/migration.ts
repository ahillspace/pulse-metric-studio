import fs from 'node:fs';
import path from 'node:path';
import { SAVED_SECRET_MAX_BYTES } from '@pulse-metric-studio/shared';
import { config } from '../config.js';
import { decryptSecretWithKey, encryptSecret } from '../db/crypto.js';
import { getDb, getSetting, type Db } from '../db/index.js';
import {
  credentialCommandHint,
  DbLlmProfileStore,
  LEGACY_PROFILES_KEY,
  type LlmProfileStore,
  type LlmSecretSource,
  type StoredLlmProfile,
} from '../llm/profiles.js';
import { CredentialBrokerError, type CredentialBrokerVaultClient } from '../tableau/credential-broker.js';

const MIGRATION_KEY = 'credentials:001';
/** Releases before 0.1.2 wrote this file once the OS store held their data key. */
const LEGACY_KEY_MARKER = 'data-key-in-os-store';

export interface SavedSecretsMigrationOptions {
  /** The native credential broker; absent in browser development. */
  broker?: CredentialBrokerVaultClient | null;
  db?: () => Db;
  dataDir?: string;
  profiles?: LlmProfileStore;
}

/**
 * Releases before 0.1.2 sealed every AI provider profile in one settings blob
 * under a data key, and created Tableau PAT entries that macOS tied to the
 * app's signature. This moves each saved secret into its own vault entry and
 * re-creates each PAT entry, then records itself so it never runs again. A
 * failure (for example a declined Keychain prompt) leaves everything in place
 * and the next launch tries again.
 */
export async function migrateSavedSecrets(options: SavedSecretsMigrationOptions = {}): Promise<void> {
  const db = options.db ?? getDb;
  if (db().prepare('SELECT 1 FROM _migrations WHERE key = ?').get(MIGRATION_KEY)) return;
  const broker = options.broker ?? null;
  const marker = path.join(options.dataDir ?? config.dataDir, LEGACY_KEY_MARKER);
  const osKey = fs.existsSync(marker);
  // Without the marker the key file encrypted everything, and it still does.
  const legacyKey = osKey ? await legacyOsKey(broker) : fileKey();

  if (osKey) reencryptConnections(db(), legacyKey);
  await moveProfiles(db(), legacyKey, options.profiles ?? new DbLlmProfileStore(db));
  if (broker) await recreatePats(db(), broker);
  if (broker) await broker.deleteLegacyDataKey();
  fs.rmSync(marker, { force: true });
  db().prepare('INSERT OR IGNORE INTO _migrations (key, applied_at) VALUES (?, ?)').run(MIGRATION_KEY, new Date().toISOString());
}

async function legacyOsKey(broker: CredentialBrokerVaultClient | null): Promise<Buffer | null> {
  if (!broker) throw new Error('Saved secrets from an earlier release need the desktop app to move them.');
  const hex = await broker.legacyDataKey();
  return hex && /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function fileKey(): Buffer | null {
  if (!fs.existsSync(config.machineKeyPath)) return null;
  const hex = fs.readFileSync(config.machineKeyPath, 'utf8').trim();
  return /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function open(blob: string, key: Buffer | null): string | null {
  if (!key) return null;
  try {
    return decryptSecretWithKey(blob, key);
  } catch {
    return null;
  }
}

/** Fallback PAT storage moves from the OS-held key to the key file. */
function reencryptConnections(db: Db, key: Buffer | null): void {
  const rows = db.prepare("SELECT id, pat_secret_enc FROM connections WHERE storage_kind = 'encrypted'").all() as Array<{ id: string; pat_secret_enc: string }>;
  const update = db.prepare('UPDATE connections SET pat_secret_enc = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const secret = open(row.pat_secret_enc, key);
      if (secret !== null) update.run(encryptSecret(secret), row.id);
    }
  })();
}

interface LegacyProfile extends Omit<StoredLlmProfile, 'secret' | 'headers' | 'credentialCommand' | 'credentialCommandHint'> {
  secret: string;
  headers: Record<string, string>;
  credentialCommand?: string;
}

async function moveProfiles(db: Db, key: Buffer | null, store: LlmProfileStore): Promise<void> {
  const blob = getSetting(db, LEGACY_PROFILES_KEY);
  if (blob) {
    const profiles = legacyProfiles(open(blob, key));
    if (!profiles) console.warn('Saved AI providers from an earlier release could not be read and were not kept.');
    for (const profile of profiles ?? []) await store.save(currentProfile(profile));
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(LEGACY_PROFILES_KEY);
}

function legacyProfiles(json: string | null): LegacyProfile[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every(isLegacyProfile) ? parsed : null;
  } catch {
    return null;
  }
}

/** A secret too long for the OS store is not kept; the provider then asks for it again. */
function currentProfile(profile: LegacyProfile): StoredLlmProfile {
  const fits = (secret: string | undefined): secret is string =>
    secret !== undefined && secret !== '' && Buffer.byteLength(secret, 'utf8') <= SAVED_SECRET_MAX_BYTES;
  const value = (secret: string | undefined): LlmSecretSource | null => (fits(secret) ? { value: secret } : null);
  const command = fits(profile.credentialCommand) ? profile.credentialCommand : undefined;
  return {
    ...profile,
    secret: value(profile.secret),
    headers: Object.fromEntries(Object.entries(profile.headers).filter(([, header]) => fits(header)).map(([name, header]) => [name, { value: header }])),
    credentialCommand: value(command),
    credentialCommandHint: credentialCommandHint(command),
    source: 'saved',
  };
}

/** Entries created now trust the system's credential tool, so app updates never prompt again. */
async function recreatePats(db: Db, broker: CredentialBrokerVaultClient): Promise<void> {
  const rows = db.prepare("SELECT id, credential_ref FROM connections WHERE storage_kind = 'os' AND credential_ref IS NOT NULL").all() as Array<{ id: string; credential_ref: string }>;
  for (const row of rows) {
    let secret: string;
    try {
      secret = await broker.resolve(row.credential_ref);
    } catch (error) {
      // A missing PAT already asks for re-entry when the connection is used.
      if (error instanceof CredentialBrokerError && error.code === 'not_found') continue;
      throw error;
    }
    // Too long for an entry the system tool can write; the existing entry keeps working.
    if (Buffer.byteLength(secret, 'utf8') > SAVED_SECRET_MAX_BYTES) continue;
    const ref = await broker.store('tableau-pat', secret);
    // The connection may have been saved again with a new PAT while this ran.
    const moved = db.prepare('UPDATE connections SET credential_ref = ? WHERE id = ? AND credential_ref = ?').run(ref, row.id, row.credential_ref).changes > 0;
    await broker.delete(moved ? row.credential_ref : ref);
  }
}

function isLegacyProfile(value: unknown): value is LegacyProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  return ['id', 'label', 'protocol', 'baseUrl', 'model', 'authMode', 'secret', 'region', 'awsProfile', 'command']
    .every((field) => typeof profile[field] === 'string')
    && Boolean(profile.headers) && typeof profile.headers === 'object' && !Array.isArray(profile.headers)
    && Object.values(profile.headers as object).every((header) => typeof header === 'string')
    && (profile.credentialCommand === undefined || typeof profile.credentialCommand === 'string');
}
