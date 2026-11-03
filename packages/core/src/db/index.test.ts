import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { closeDb, getDb, registerDbMigrations } from './index.js';

test('receipt migration preserves legacy IDs, payloads and failures without guessing ownership', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'receipt-migration-'),
  );
  config.dataDir = directory;
  config.dbPath = path.join(directory, 'test.db');
  try {
    const db = getDb();
    // Reconstruct the real version-002 ledger schema and retained data.
    db.exec(`DROP TABLE run_metrics; DROP TABLE pulse_drafts; DROP INDEX runs_owner_created;
      ALTER TABLE runs DROP COLUMN server_url; ALTER TABLE runs DROP COLUMN site_id;
      DELETE FROM _migrations WHERE key IN ('migration:003', 'migration:004');
      CREATE TABLE run_metrics (run_id TEXT NOT NULL, definition_id TEXT NOT NULL, metric_id TEXT,
        name TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY(run_id, definition_id));
      INSERT INTO runs(id,connection_id,datasource_luid,datasource_name,created_at,summary) VALUES('run','connection','ds','DS',1,'{}');
      INSERT INTO run_metrics VALUES('run','','','invalid','{"name":"invalid"}','failed','problem',1);
      INSERT INTO run_metrics VALUES('run','remote-id','metric-id','created','{"name":"created"}','created',NULL,2);`);
    closeDb();
    const migrated = getDb();
    const rows = migrated
      .prepare('SELECT * FROM run_metrics ORDER BY item_index')
      .all() as any[];
    assert.deepEqual(
      rows.map((row) => row.item_index),
      [0, 1],
    );
    assert.equal(rows[0].definition_id, null);
    assert.equal(rows[0].error, 'problem');
    assert.equal(rows[1].definition_id, 'remote-id');
    assert.equal(rows[1].metric_id, 'metric-id');
    assert.equal(rows[1].payload_json, '{"name":"created"}');
    assert.equal(rows[1].creation_status, 'created');
    assert.equal(
      (migrated.prepare('SELECT site_id FROM runs').get() as any).site_id,
      null,
    );
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('feature migration failure rolls back schema and data and retains its pre-migration backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-rollback-'));
  config.dataDir = directory;
  config.dbPath = path.join(directory, 'test.db');
  try {
    const db = getDb();
    db.prepare('INSERT INTO settings VALUES(?,?)').run('keep', 'original');
    assert.throws(
      () =>
        registerDbMigrations('fixture', [
          {
            version: 1,
            migrate(database) {
              database.exec(
                "CREATE TABLE fixture_partial(id TEXT); UPDATE settings SET value='changed' WHERE key='keep'",
              );
              throw new Error('Migration interrupted');
            },
          },
        ]),
      /Migration interrupted/,
    );
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key='keep'").pluck().get(),
      'original',
    );
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='fixture_partial'")
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT key FROM _migrations WHERE key='fixture:001'").get(),
      undefined,
    );
    assert.ok(fs.existsSync(`${config.dbPath}.before-fixture-001.sqlite`));
  } finally {
    closeDb();
    registerDbMigrations('fixture', []);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Chat compatibility migration preserves profiles, secret references and selection and rolls back interrupted ledger writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-contract-migration-'));
  config.dataDir = directory; config.dbPath = path.join(directory, 'test.db');
  try {
    const db = getDb();
    db.exec(`ALTER TABLE llm_profiles DROP COLUMN chat_compatibility;
      DELETE FROM _migrations WHERE key='migration:006';
      INSERT INTO settings VALUES('llm.provider','saved-provider');
      INSERT INTO llm_profiles (id,label,protocol,base_url,model,auth_mode,secret_ref,header_refs_json,region,aws_profile,command,credential_command_ref,credential_command_hint,allow_private_network,created_at,updated_at)
      VALUES('saved-provider','Saved','openai-chat','https://gateway.example.test/v1','fixture','bearer','saved-secret-ref','{"x-route":"saved-header-ref"}','','','','saved-command-ref','fixture',0,1,2);
      CREATE TRIGGER reject_contract_migration BEFORE INSERT ON _migrations WHEN NEW.key='migration:006' BEGIN SELECT RAISE(ABORT,'Migration interrupted'); END;`);
    closeDb();
    assert.throws(() => getDb(), /Migration interrupted/);
    const inspect = new Database(config.dbPath);
    assert.equal((inspect.prepare('PRAGMA table_info(llm_profiles)').all() as Array<{ name: string }>).some(column => column.name === 'chat_compatibility'), false);
    assert.equal(inspect.prepare("SELECT key FROM _migrations WHERE key='migration:006'").get(), undefined);
    inspect.exec('DROP TRIGGER reject_contract_migration'); inspect.close();
    const migrated = getDb();
    const saved = migrated.prepare("SELECT * FROM llm_profiles WHERE id='saved-provider'").get() as any;
    assert.equal(saved.chat_compatibility, 'auto');
    assert.equal(saved.secret_ref, 'saved-secret-ref');
    assert.equal(saved.header_refs_json, '{"x-route":"saved-header-ref"}');
    assert.equal(saved.credential_command_ref, 'saved-command-ref');
    assert.equal(saved.created_at, 1); assert.equal(saved.updated_at, 2);
    assert.equal(migrated.prepare("SELECT value FROM settings WHERE key='llm.provider'").pluck().get(), 'saved-provider');
    assert.ok(migrated.prepare("SELECT key FROM _migrations WHERE key='migration:006'").get());
  } finally { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); }
});
