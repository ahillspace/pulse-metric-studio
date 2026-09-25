import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertSupportedNode(version = process.versions.node) {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version.trim());
  if (!match || Number(match[1]) < 22) {
    throw new Error(`Node.js 22 or newer is required by the SQLite runtime; found ${version}. Use Node.js 22 LTS or newer.`);
  }
}

export function validateNodeExecutable(executable) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect Node runtime ${executable}: ${result.error?.message ?? result.stderr}`);
  assertSupportedNode(result.stdout);
}

export function verifyPackagedSqlite(executable, serverDist) {
  validateNodeExecutable(executable);
  const source = `
    const Database = require(process.argv[1]);
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE runtime_check (value TEXT NOT NULL)');
      db.prepare('INSERT INTO runtime_check VALUES (?)').run('verified');
      if (db.prepare('SELECT value FROM runtime_check').get().value !== 'verified') throw new Error('SQLite round trip failed');
    } finally { db.close(); }
  `;
  const sqlitePath = path.join(path.resolve(serverDist), 'node_modules', 'better-sqlite3');
  const result = spawnSync(executable, ['-e', source, sqlitePath], { cwd: serverDist, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged Node/SQLite compatibility check failed (${result.signal ?? result.status}): ${result.error?.message ?? result.stderr}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertSupportedNode(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
