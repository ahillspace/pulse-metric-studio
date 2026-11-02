import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CredentialBrokerVaultClient, StoredCredentialKind } from '../tableau/credential-broker.js';
import type { SecretVault } from './vault.js';

const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-secrets-migration-'));
const previousDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
process.env.PULSE_METRIC_STUDIO_DATA_DIR = temporaryDataDir;

const { closeDb, getDb } = await import('../db/index.js');
const { decryptSecret, encryptSecret } = await import('../db/crypto.js');
const { CredentialBrokerError } = await import('../tableau/credential-broker.js');
const { DbLlmProfileStore } = await import('../llm/profiles.js');
const { migrateSavedSecrets } = await import('./migration.js');

test.after(() => {
  closeDb();
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = previousDataDir;
});

const marker = path.join(temporaryDataDir, 'data-key-in-os-store');
const legacyProfile = {
  id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'model',
  authMode: 'bearer', secret: 'legacy-api-key', headers: { 'x-route': 'legacy-route' }, region: '', awsProfile: '', command: '',
  credentialCommand: '/usr/local/bin/mint --secret abc', allowPrivateNetwork: false, source: 'saved',
};

/** The sealed format releases before 0.1.2 used, under whichever key they held. */
function seal(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

class FakeBroker implements CredentialBrokerVaultClient {
  readonly entries = new Map<string, string>();
  legacyKey: string | null = null;
  denyLegacyKey = false;
  private next = 0;

  async resolve(ref: string): Promise<string> {
    const secret = this.entries.get(ref);
    if (secret === undefined) throw new CredentialBrokerError('not_found', 'The saved OS credential was not found.');
    return secret;
  }

  async store(kind: StoredCredentialKind, secret: string): Promise<string> {
    const ref = `${kind === 'tableau-pat' ? 'cred' : 'llm'}_${++this.next}`;
    this.entries.set(ref, secret);
    return ref;
  }

  async delete(ref: string): Promise<boolean> {
    return this.entries.delete(ref);
  }

  async legacyDataKey(): Promise<string | null> {
    if (this.denyLegacyKey) throw new CredentialBrokerError('unavailable', 'The OS credential broker request failed.');
    return this.legacyKey;
  }

  async deleteLegacyDataKey(): Promise<void> {
    this.legacyKey = null;
  }

  async approveCredentialCommand(): Promise<boolean> {
    return true;
  }
}

class MemoryVault implements SecretVault {
  readonly location = 'the test vault';
  readonly secrets = new Map<string, string>();
  private next = 0;
  async store(secret: string) { const ref = `ref_${++this.next}`; this.secrets.set(ref, secret); return ref; }
  async resolve(ref: string) { return this.secrets.get(ref)!; }
  async delete(ref: string) { this.secrets.delete(ref); }
}

function reset() {
  const db = getDb();
  db.exec("DELETE FROM llm_profiles; DELETE FROM settings; DELETE FROM connections; DELETE FROM _migrations WHERE key = 'credentials:001';");
  fs.rmSync(marker, { force: true });
  const vault = new MemoryVault();
  return { db, vault, profiles: new DbLlmProfileStore(() => db, () => vault) };
}

function addConnection(id: string, storageKind: 'os' | 'encrypted', value: string) {
  getDb().prepare(
    `INSERT INTO connections (id, label, server_url, site_content_url, pat_name, pat_secret_enc, credential_ref, storage_kind, created_at)
     VALUES (?, ?, 'https://tableau.example.test', '', 'pat', ?, ?, ?, 0)`,
  ).run(id, id, storageKind === 'encrypted' ? value : '', storageKind === 'os' ? value : null, storageKind);
}

function connection(id: string) {
  return getDb().prepare('SELECT pat_secret_enc, credential_ref FROM connections WHERE id = ?').get(id) as { pat_secret_enc: string; credential_ref: string | null };
}

function revealed(vault: MemoryVault, profiles: InstanceType<typeof DbLlmProfileStore>) {
  const [profile] = profiles.list();
  const reveal = (source: { ref: string } | { value: string } | null) => (source && 'ref' in source ? vault.secrets.get(source.ref) : source);
  return {
    ...profile,
    secret: reveal(profile.secret),
    headers: Object.fromEntries(Object.entries(profile.headers).map(([name, source]) => [name, reveal(source)])),
    credentialCommand: reveal(profile.credentialCommand),
  };
}

test('desktop secrets from an OS-held data key move into their own entries once', async () => {
  const { db, vault, profiles } = reset();
  const osKey = crypto.randomBytes(32);
  const broker = new FakeBroker();
  broker.legacyKey = osKey.toString('hex');
  broker.entries.set('cred_old', 'legacy-pat-secret');
  fs.writeFileSync(marker, 'legacy');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', seal(JSON.stringify([legacyProfile]), osKey));
  addConnection('fallback', 'encrypted', seal('fallback-pat-secret', osKey));
  addConnection('native', 'os', 'cred_old');
  addConnection('missing', 'os', 'cred_gone');

  await migrateSavedSecrets({ broker, profiles });

  const moved = revealed(vault, profiles);
  assert.equal(moved.secret, 'legacy-api-key');
  assert.deepEqual(moved.headers, { 'x-route': 'legacy-route' });
  assert.equal(moved.credentialCommand, '/usr/local/bin/mint --secret abc');
  assert.equal(moved.credentialCommandHint, 'mint ...');
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key = 'llm.profiles.v1'").get(), undefined);
  assert.equal(decryptSecret(connection('fallback').pat_secret_enc), 'fallback-pat-secret');
  const recreated = connection('native').credential_ref!;
  assert.notEqual(recreated, 'cred_old');
  assert.equal(broker.entries.get(recreated), 'legacy-pat-secret');
  assert.equal(broker.entries.has('cred_old'), false);
  assert.equal(connection('missing').credential_ref, 'cred_gone');
  assert.equal(broker.legacyKey, null);
  assert.equal(fs.existsSync(marker), false);

  broker.entries.set('cred_again', 'x');
  db.prepare("UPDATE connections SET credential_ref = 'cred_again' WHERE id = 'native'").run();
  await migrateSavedSecrets({ broker, profiles });
  assert.equal(connection('native').credential_ref, 'cred_again', 'a recorded migration never runs again');
});

test('a declined OS store prompt leaves everything in place for the next launch', async () => {
  const { db, vault, profiles } = reset();
  const osKey = crypto.randomBytes(32);
  const broker = new FakeBroker();
  broker.legacyKey = osKey.toString('hex');
  broker.denyLegacyKey = true;
  fs.writeFileSync(marker, 'legacy');
  const sealed = seal(JSON.stringify([legacyProfile]), osKey);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', sealed);

  await assert.rejects(migrateSavedSecrets({ broker, profiles }), CredentialBrokerError);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'llm.profiles.v1'").pluck().get(), sealed);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(vault.secrets.size, 0);

  broker.denyLegacyKey = false;
  await migrateSavedSecrets({ broker, profiles });
  assert.equal(revealed(vault, profiles).secret, 'legacy-api-key');
});

test('browser development moves profiles sealed under the key file', async () => {
  const { db, vault, profiles } = reset();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', encryptSecret(JSON.stringify([legacyProfile])));

  await migrateSavedSecrets({ profiles });

  assert.equal(revealed(vault, profiles).secret, 'legacy-api-key');
  assert.ok(db.prepare("SELECT 1 FROM _migrations WHERE key = 'credentials:001'").get());
});

test('unreadable legacy profiles are dropped rather than blocking AI settings forever', async () => {
  const { db, profiles } = reset();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', 'v1.corrupt');

  await migrateSavedSecrets({ profiles });

  assert.deepEqual(profiles.list(), []);
});

test('a legacy secret too long for the OS store is dropped so the provider asks for it again', async () => {
  const { db, vault, profiles } = reset();
  const long = 'x'.repeat(1201);
  const profile = { ...legacyProfile, secret: long, headers: { 'x-route': 'legacy-route', 'x-long': long } };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', encryptSecret(JSON.stringify([profile])));

  await migrateSavedSecrets({ profiles });

  const moved = revealed(vault, profiles);
  assert.equal(moved.secret, null);
  assert.deepEqual(moved.headers, { 'x-route': 'legacy-route' });
  assert.equal(moved.credentialCommand, '/usr/local/bin/mint --secret abc');
});

test('a PAT saved again while the migration runs keeps its new entry', async () => {
  const { profiles } = reset();
  const broker = new FakeBroker();
  broker.entries.set('cred_old', 'legacy-pat-secret');
  addConnection('native', 'os', 'cred_old');
  const store = broker.store.bind(broker);
  broker.store = async (kind, secret) => {
    const ref = await store(kind, secret);
    broker.entries.set('cred_new', 'replacement-pat');
    getDb().prepare("UPDATE connections SET credential_ref = 'cred_new' WHERE id = 'native'").run();
    return ref;
  };

  await migrateSavedSecrets({ broker, profiles });

  assert.equal(connection('native').credential_ref, 'cred_new');
  assert.deepEqual([...broker.entries.keys()].sort(), ['cred_new', 'cred_old']);
});
