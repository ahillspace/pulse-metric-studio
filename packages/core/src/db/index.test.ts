import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { closeDb, getDb } from './index.js';

test('receipt migration preserves legacy IDs, payloads and failures without guessing ownership', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-migration-'));
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
    const rows = migrated.prepare('SELECT * FROM run_metrics ORDER BY item_index').all() as any[];
    assert.deepEqual(rows.map((row) => row.item_index), [0, 1]);
    assert.equal(rows[0].definition_id, null);
    assert.equal(rows[0].error, 'problem');
    assert.equal(rows[1].definition_id, 'remote-id');
    assert.equal(rows[1].metric_id, 'metric-id');
    assert.equal(rows[1].payload_json, '{"name":"created"}');
    assert.equal(rows[1].creation_status, 'created');
    assert.equal((migrated.prepare('SELECT site_id FROM runs').get() as any).site_id, null);
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
