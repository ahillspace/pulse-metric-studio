import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-rp10-session-'));
const previousDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
process.env.PULSE_METRIC_STUDIO_DATA_DIR = temporaryDataDir;

createLegacyDatabase(path.join(temporaryDataDir, 'pulse-metric-studio.db'));

const databaseModule = await import('../db/index.js');
const sessionModule = await import('./session.js');

test.after(() => {
  sessionModule.clearSession();
  databaseModule.closeDb();
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = previousDataDir;
});

test('migrates legacy encrypted connections without exposing their PAT', async () => {
  const database = databaseModule.getDb();
  const columns = database.prepare("PRAGMA table_info('connections')").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === 'credential_ref'));
  assert.ok(columns.some((column) => column.name === 'storage_kind'));

  const summary = sessionModule.listConnections().find((connection) => connection.id === 'legacy-id');
  assert.equal(summary?.storageKind, 'encrypted');
  assert.equal(summary?.credentialRef, null);
  assert.equal(summary?.patName, 'legacy-pat');
  assert.equal(JSON.stringify(summary).includes('legacy-encrypted-value'), false);
  await assert.rejects(
    sessionModule.resolveConnectionSecret(sessionModule.getStoredConnection('legacy-id')!),
    (error: unknown) => error instanceof sessionModule.StoredCredentialError
      && error.code === 'unreadable_encrypted_secret',
  );
});

test('stores only a credential reference for an OS-managed connection', async () => {
  const profile = sessionModule.saveConnection({
    label: 'Tableau Cloud',
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
  });
  const row = databaseModule.getDb().prepare(
    'SELECT pat_secret_enc, credential_ref, storage_kind FROM connections WHERE id = ?',
  ).get(profile.id) as { pat_secret_enc: string; credential_ref: string; storage_kind: string };
  assert.deepEqual(row, {
    pat_secret_enc: '',
    credential_ref: 'credential-ref-1',
    storage_kind: 'os',
  });

  const stored = sessionModule.getStoredConnection(profile.id)!;
  let resolvedRef = '';
  const secret = await sessionModule.resolveConnectionSecret(stored, {
    async resolve(credentialRef) {
      resolvedRef = credentialRef;
      return 'broker-secret';
    },
  });
  assert.equal(resolvedRef, 'credential-ref-1');
  assert.equal(secret, 'broker-secret');
  assert.equal(JSON.stringify(sessionModule.listConnections()).includes('broker-secret'), false);
});

test('uses a client operation ID as the stable connection ID', () => {
  const operationId = '22222222-2222-4222-8222-222222222222';
  const profile = sessionModule.saveConnection({
    id: operationId,
    label: 'Idempotent Tableau connection',
    serverUrl: 'https://idempotent.example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-idempotent',
  });

  assert.equal(profile.id, operationId);
  assert.equal(sessionModule.getStoredConnection(operationId)?.credentialRef, 'credential-ref-idempotent');
});

test('keeps encrypted fallback storage explicit and replaces it without plaintext persistence', async () => {
  const profile = sessionModule.saveConnection({
    label: 'Browser fallback',
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: '',
    patName: 'browser-pat',
    storageKind: 'encrypted',
    patSecret: 'first-secret',
  });
  const first = sessionModule.getStoredConnection(profile.id)!;
  assert.equal(first.storageKind, 'encrypted');
  assert.equal(first.credentialRef, null);
  assert.equal(first.patSecretEnc.includes('first-secret'), false);
  assert.equal(await sessionModule.resolveConnectionSecret(first), 'first-secret');

  const replaced = sessionModule.replaceConnectionCredential(profile.id, {
    storageKind: 'encrypted',
    patSecret: 'second-secret',
    patName: 'replacement-pat',
  });
  assert.equal(replaced?.patName, 'replacement-pat');
  assert.equal(await sessionModule.resolveConnectionSecret(sessionModule.getStoredConnection(profile.id)!), 'second-secret');
  assert.equal(sessionModule.deleteConnection(profile.id)?.storageKind, 'encrypted');
  assert.equal(sessionModule.getStoredConnection(profile.id), null);
});

function createLegacyDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE _migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO _migrations (key, applied_at) VALUES ('migration:001', '2026-08-29T00:00:00.000Z');

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      server_url TEXT NOT NULL,
      site_content_url TEXT NOT NULL DEFAULT '',
      pat_name TEXT NOT NULL,
      pat_secret_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );

    CREATE TABLE runs (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, datasource_luid TEXT NOT NULL,
      datasource_name TEXT NOT NULL, group_id TEXT, group_name TEXT,
      created_at INTEGER NOT NULL, summary TEXT NOT NULL
    );
    CREATE TABLE run_metrics (
      run_id TEXT NOT NULL, definition_id TEXT NOT NULL, metric_id TEXT,
      name TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      error TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, definition_id)
    );
    CREATE TABLE drafts (
      datasource_luid TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );

    INSERT INTO connections (
      id, label, server_url, site_content_url, pat_name, pat_secret_enc, created_at
    ) VALUES (
      'legacy-id', 'Legacy connection', 'https://legacy.example.com', 'site',
      'legacy-pat', 'legacy-encrypted-value', 1
    );
  `);
  database.close();
}
