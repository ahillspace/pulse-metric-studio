import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { bundleServer } from './bundle-server.mjs';
import { buildNativeStageWorkspaces, linkNativeStageDependencies } from './native-stage-dependencies.mjs';
import { captureSourceIdentity } from './release-provenance.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
function write(directory, file, content) {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function link(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.symlinkSync(from, to, directoryLink);
}
function git(directory, ...args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test('production native bundles retain staged workspace source through direct and third-party nested imports', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-native-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const stage = path.join(directory, 'stage');
  write(source, 'package.json', JSON.stringify({ type: 'module', workspaces: ['packages/shared', 'packages/server'] }));
  write(source, '.gitignore', 'node_modules/\ndist/\n');
  for (const name of ['shared', 'server']) {
    write(source, `packages/${name}/package.json`, JSON.stringify({ name: `@fixture/${name}`, type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts', scripts: { build: 'tsc -p tsconfig.json' } }));
    write(source, `packages/${name}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist', declaration: true, skipLibCheck: true, types: [] }, include: ['src'] }));
  }
  write(source, 'packages/shared/src/index.ts', 'export const sentinel = "STAGED_SOURCE_A";');
  write(source, 'packages/shared/dist/index.js', 'export const sentinel = "STAGED_SOURCE_A";');
  write(source, 'packages/shared/dist/index.d.ts', 'export declare const sentinel: string;');
  write(source, 'packages/server/src/index.ts', `
    import { sentinel } from '@fixture/shared';
    import { bridged } from 'third-party-bridge';
    console.log(JSON.stringify([sentinel, bridged]));
  `);
  write(source, 'node_modules/third-party-bridge/package.json', JSON.stringify({ name: 'third-party-bridge', type: 'module', main: 'index.js' }));
  write(source, 'node_modules/third-party-bridge/index.js', 'export { sentinel as bridged } from "@fixture/shared";');
  const shared = path.join(source, 'packages/shared');
  for (const modules of ['node_modules', 'packages/server/node_modules', 'node_modules/third-party-bridge/node_modules']) {
    link(shared, path.join(source, modules, '@fixture/shared'));
  }
  link(path.join(root, 'node_modules/better-sqlite3'), path.join(source, 'node_modules/better-sqlite3'));
  link(path.join(root, 'node_modules/typescript'), path.join(source, 'node_modules/typescript'));
  if (process.platform === 'win32') write(source, 'node_modules/.bin/tsc.cmd', '@echo off\r\nnode "%~dp0\\..\\typescript\\bin\\tsc" %*\r\n');
  else {
    fs.mkdirSync(path.join(source, 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync('../typescript/bin/tsc', path.join(source, 'node_modules/.bin/tsc'));
  }
  git(source, 'init', '-q');
  git(source, 'config', 'user.name', 'Fixture Builder');
  git(source, 'config', 'user.email', 'fixture-noreply@example.test');
  git(source, 'add', '.');
  git(source, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture source');
  const identity = captureSourceIdentity(source);
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const originalBin = fs.readFileSync(path.join(source, 'node_modules/.bin', binName));
  const originalBinStat = fs.statSync(path.join(source, 'node_modules/.bin', binName));
  fs.cpSync(source, stage, { recursive: true, filter: (file) => !['node_modules', '.git'].includes(path.basename(file)) });
  write(stage, 'packages/shared/dist/index.js', 'export const sentinel = "STALE_COPIED_DIST";');
  write(stage, 'packages/shared/dist/stale-only.js', 'throw new Error("Ignored output must not survive the stage rebuild");');
  linkNativeStageDependencies(source, stage);
  const entrypoint = path.join(stage, 'src-tauri/resources/server/dist/index.mjs');
  const bundleAndRun = async () => {
    buildNativeStageWorkspaces(stage);
    await bundleServer(stage);
    const bytes = fs.readFileSync(entrypoint);
    const result = spawnSync(process.execPath, [entrypoint], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    return { bytes, value: JSON.parse(result.stdout.trim()) };
  };
  const first = await bundleAndRun();
  assert.deepEqual(first.value, ['STAGED_SOURCE_A', 'STAGED_SOURCE_A']);
  assert.equal(fs.existsSync(path.join(stage, 'packages/shared/dist/stale-only.js')), false);
  write(source, 'packages/shared/dist/index.js', 'export const sentinel = "CHANGED_ORIGINAL_DIST_B";');
  assert.deepEqual(captureSourceIdentity(source), identity, 'ignored checkout dist does not change captured source identity');
  write(source, 'packages/shared/src/index.ts', 'export const sentinel = "CHANGED_ORIGINAL_SOURCE_B";');
  const second = await bundleAndRun();
  assert.deepEqual(second.value, ['STAGED_SOURCE_A', 'STAGED_SOURCE_A']);
  assert.deepEqual(second.bytes, first.bytes);
  const requireRoot = createRequire(path.join(stage, 'entry.cjs'));
  const requireServer = createRequire(path.join(stage, 'packages/server/entry.cjs'));
  const requireBridge = createRequire(path.join(stage, 'node_modules/third-party-bridge/index.js'));
  for (const require of [requireRoot, requireServer, requireBridge]) {
    assert.equal(fs.realpathSync(require.resolve('@fixture/shared')), path.join(stage, 'packages/shared/dist/index.js'));
  }
  assert.equal(fs.realpathSync(path.join(source, 'node_modules/@fixture/shared')), shared, 'staging never rewrites original workspace links');
  fs.appendFileSync(path.join(stage, 'node_modules/.bin', binName), process.platform === 'win32' ? '\r\nREM staged-only\r\n' : '\n# staged-only\n');
  assert.deepEqual(fs.readFileSync(path.join(source, 'node_modules/.bin', binName)), originalBin, 'staged command files are not writable hard links into the checkout');
  const unchangedBinStat = fs.statSync(path.join(source, 'node_modules/.bin', binName));
  assert.deepEqual([unchangedBinStat.dev, unchangedBinStat.ino], [originalBinStat.dev, originalBinStat.ino]);
  assert.match(fs.readFileSync(path.join(source, 'packages/shared/dist/index.js'), 'utf8'), /CHANGED_ORIGINAL_DIST_B/, 'stage rebuild never rewrites original compiled outputs');
});
