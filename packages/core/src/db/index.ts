import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config } from '../config.js';

export type Db = Database.Database;

let db: Db | null = null;

const MIGRATIONS: string[] = [
  // 001 — initial schema
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    server_url TEXT NOT NULL,
    site_content_url TEXT NOT NULL DEFAULT '',
    pat_name TEXT NOT NULL,
    pat_secret_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    datasource_luid TEXT NOT NULL,
    datasource_name TEXT NOT NULL,
    group_id TEXT,
    group_name TEXT,
    created_at INTEGER NOT NULL,
    summary TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_metrics (
    run_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    metric_id TEXT,
    name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, definition_id)
  );

  CREATE TABLE IF NOT EXISTS drafts (
    datasource_luid TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 002 - distinguish OS-managed credentials from the encrypted fallback
  `
  ALTER TABLE connections ADD COLUMN credential_ref TEXT;
  ALTER TABLE connections ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'encrypted';

  UPDATE connections
  SET storage_kind = 'encrypted'
  WHERE storage_kind IS NULL OR storage_kind = '';
  `,
  // 003 - stable receipt items and immutable owner coordinates.
  `
  ALTER TABLE runs ADD COLUMN server_url TEXT;
  ALTER TABLE runs ADD COLUMN site_id TEXT;
  ALTER TABLE run_metrics RENAME TO run_metrics_legacy;
  CREATE TABLE run_metrics (
    run_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    definition_id TEXT,
    metric_id TEXT,
    name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    creation_status TEXT NOT NULL,
    resolution_status TEXT,
    undo_status TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, item_index)
  );
  INSERT INTO run_metrics
  SELECT run_id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at, definition_id) - 1,
    NULLIF(definition_id, ''), NULLIF(metric_id, ''), name, payload_json, status,
    CASE WHEN definition_id <> '' THEN 'created' ELSE 'unknown' END,
    CASE WHEN definition_id <> '' THEN CASE WHEN COALESCE(metric_id, '') <> '' THEN 'resolved' ELSE 'pending' END END,
    CASE WHEN definition_id <> '' THEN 'pending' END, error, created_at
  FROM run_metrics_legacy;
  DROP TABLE run_metrics_legacy;
  CREATE INDEX runs_owner_created ON runs(connection_id, server_url, site_id, created_at DESC);
  CREATE TABLE pulse_drafts (
    connection_id TEXT NOT NULL,
    server_url TEXT NOT NULL,
    site_id TEXT NOT NULL,
    datasource_luid TEXT NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(connection_id, server_url, site_id, datasource_luid)
  );
  `,
  // 004 - retain undo diagnostics independently from creation/resolution errors.
  `ALTER TABLE run_metrics ADD COLUMN undo_error TEXT;`,
];

export function getDb(): Db {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec('CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const appliedRows = db.prepare('SELECT key FROM _migrations').all() as Array<{ key: string }>;
  const appliedKeys = new Set(appliedRows.map((r) => r.key));

  MIGRATIONS.forEach((sql, i) => {
    const key = `migration:${String(i + 1).padStart(3, '0')}`;
    if (appliedKeys.has(key)) return;
    const tx = db!.transaction(() => {
      db!.exec(sql);
      db!.prepare('INSERT INTO _migrations (key, applied_at) VALUES (?, ?)').run(key, new Date().toISOString());
    });
    tx();
  });

  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

// -- settings helpers ---------------------------------------------------------

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
