import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requirement = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node;
const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(requirement)?.slice(1).map(Number);
if (!minimum) throw new Error('The package Node.js requirement must declare a minimum three-part version.');

export function assertSupportedNode(version = process.versions.node) {
  const current = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())?.slice(1).map(Number);
  const difference = current?.findIndex((value, index) => value !== minimum[index]);
  if (!current || (difference !== -1 && current[difference] < minimum[difference])) {
    throw new Error(`Node.js ${minimum.join('.')} or newer is required; found ${version}. Use the version in .nvmrc.`);
  }
}

export function validateNodeExecutable(executable, run = spawnSync) {
  const result = run(executable, ['--use-system-ca', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect Node runtime ${executable}: ${result.error?.message ?? result.stderr}`);
  assertSupportedNode(result.stdout);
}

export function verifyPackagedSqlite(executable, serverDist, run = spawnSync) {
  validateNodeExecutable(executable, run);
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
  const result = run(executable, ['--use-system-ca', '-e', source, sqlitePath], { cwd: serverDist, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged Node/SQLite compatibility check failed (${result.signal ?? result.status}): ${result.error?.message ?? result.stderr}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertSupportedNode(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
