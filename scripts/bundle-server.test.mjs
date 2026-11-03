import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleServer, copySqliteRuntime } from './bundle-server.mjs';
import { copyNodeRuntime } from './copy-resources.mjs';
import { inspectNodeTarget, verifyPackagedSqlite } from './node-runtime.mjs';
import { linkNativeStageDependencies } from './native-stage-dependencies.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const installedSqlite = path.join(root, 'node_modules', 'better-sqlite3');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sqlite-bundle-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pulse-sqlite-bundle-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function write(directory, filename, content = 'build metadata') {
  const target = path.join(directory, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function files(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
}

test('SQLite target comes from the supplied bundled runtime, including cross-platform targets', () => {
  for (const target of [{ platform: 'win32', arch: 'x64', glibc: null }, { platform: 'darwin', arch: 'arm64', glibc: null }, { platform: 'linux', arch: 'x64', glibc: false }]) {
    const result = inspectNodeTarget('fixture-node', (executable, args) => {
      assert.equal(executable, 'fixture-node');
      assert.equal(args[0], '--use-system-ca');
      return { status: 0, stdout: JSON.stringify(target) };
    });
    assert.deepEqual(result, { platform: target.platform === 'linux' ? 'linuxmusl' : target.platform, arch: target.arch });
  }
  assert.throws(() => inspectNodeTarget('bad', () => ({ status: 0, stdout: '{"platform":"win32","arch":"ia32"}' })), /unsupported/);
  assert.throws(() => inspectNodeTarget('bad', () => ({ status: 1, stdout: '' })), /Cannot inspect/);
});

test('SQLite resources prefer only the bundled runtime target prebuild', (t) => {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'packaged');
  const runtime = ['package.json', 'LICENSE', 'lib/index.js', 'lib/methods/transaction.js',
    'build/Debug/better_sqlite3.node', 'build/Release/better_sqlite3.node'];
  for (const platform of ['darwin', 'win32', 'linux', 'linuxmusl']) {
    for (const architecture of ['arm64', 'x64']) runtime.push(`prebuilds/${platform}-${architecture}.node`);
  }
  for (const filename of runtime) write(source, filename, 'runtime');
  for (const filename of ['README.md', 'binding.gyp', 'deps/sqlite3/sqlite3.c', 'src/addon.cpp',
    'build/config.gypi', 'build/better_sqlite3.vcxproj', 'build/Release/obj/addon.recipe',
    'build/Release/obj/addon.tlog/compile.tlog', 'build/Release/addon.pdb',
    'build/Release/test_extension.node', 'build/future-tool/output.txt',
    'prebuilds/build-info.json', 'prebuilds/unsupported.node', 'lib/index.js.map']) {
    write(source, filename);
  }
  write(destination, 'build/Release/stale.recipe');

  copySqliteRuntime(source, destination, { platform: 'win32', arch: 'x64' });

  const shared = runtime.filter(filename => !filename.startsWith('prebuilds/') && !filename.startsWith('build/'));
  assert.deepEqual(files(destination), [...shared, 'prebuilds/win32-x64.node'].sort());
  copySqliteRuntime(source, destination, { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(files(destination), [...shared, 'prebuilds/darwin-arm64.node'].sort());
});

test('SQLite falls back to one compiled addon only when the target prebuild is absent', (t) => {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'packaged');
  for (const filename of ['package.json', 'LICENSE', 'lib/index.js', 'build/Debug/better_sqlite3.node', 'build/Release/better_sqlite3.node', 'prebuilds/darwin-arm64.node']) write(source, filename);
  copySqliteRuntime(source, destination, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(files(destination), ['LICENSE', 'build/Release/better_sqlite3.node', 'lib/index.js', 'package.json']);
});

test('SQLite resource composition rejects a package without a native addon', (t) => {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  for (const filename of ['package.json', 'LICENSE', 'lib/index.js']) write(source, filename);
  assert.throws(() => copySqliteRuntime(source, path.join(directory, 'packaged'), { platform: 'win32', arch: 'x64' }), /Missing better-sqlite3 native addon/);
});

test('native-stage bundles preserve logical dependency paths without exposing the source checkout', (t) => {
  const directory = temporary(t);
  const privateMarker = 'private-build-root';
  const sourceRoot = path.join(directory, privateMarker);
  const stage = path.join(directory, 'stage');
  write(sourceRoot, 'package.json', JSON.stringify({ workspaces: [] }));
  write(sourceRoot, 'node_modules/bundle-privacy-fixture/package.json', JSON.stringify({ main: 'index.js' }));
  write(sourceRoot, 'node_modules/bundle-privacy-fixture/index.js', 'module.exports = 42;');
  fs.symlinkSync(installedSqlite, path.join(sourceRoot, 'node_modules/better-sqlite3'),
    process.platform === 'win32' ? 'junction' : 'dir');
  write(stage, 'packages/server/src/index.ts', `
    import value from 'bundle-privacy-fixture';
    import Database from 'better-sqlite3';
    const db = new Database(':memory:');
    try {
      if (db.prepare('SELECT ? AS value').get(value).value !== 42) throw new Error('Staged dependency failed');
    } finally { db.close(); }
  `);
  linkNativeStageDependencies(sourceRoot, stage);
  const script = pathToFileURL(path.join(root, 'scripts/bundle-server.mjs')).href;
  // A fresh process matches packaging: esbuild starts its service in the stage.
  const bundled = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { bundleServer } from ${JSON.stringify(script)}; await bundleServer(${JSON.stringify(stage)});`], {
    cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(bundled.error, undefined);
  assert.equal(bundled.status, 0, bundled.stderr);
  const serverDist = path.join(stage, 'src-tauri/resources/server/dist');
  const entrypoint = path.join(serverDist, 'index.mjs');
  const contents = fs.readFileSync(entrypoint);
  assert.equal(contents.includes(Buffer.from(privateMarker)), false);
  assert.equal(contents.includes(Buffer.from(privateMarker, 'utf16le')), false);
  const node = copyNodeRuntime(path.join(stage, 'src-tauri/resources'));
  verifyPackagedSqlite(node, serverDist);
  const result = spawnSync(node, ['--use-system-ca', entrypoint], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

for (const layout of ['prebuild', 'Debug', 'Release']) {
  test(`bundled SQLite runs with packaged Node using the ${layout} native layout`, async (t) => {
    const directory = temporary(t);
    const sourceRoot = path.join(directory, 'source');
    const source = path.join(sourceRoot, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(source, { recursive: true });
    for (const filename of ['package.json', 'LICENSE', 'lib']) {
      fs.cpSync(path.join(installedSqlite, filename), path.join(source, filename), { recursive: true });
    }
    const binding = createRequire(import.meta.url)(path.join(installedSqlite, 'lib', 'binding.js'));
    const installedAddon = binding.getPrebuildPath()
      ?? ['Debug', 'Release'].map((configuration) => path.join(installedSqlite, 'build', configuration, 'better_sqlite3.node'))
        .find((filename) => fs.existsSync(filename));
    assert.ok(installedAddon, 'installed SQLite must have a native addon');
    const platform = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
      ? 'linuxmusl' : process.platform;
    const relativeAddon = layout === 'prebuild'
      ? path.join('prebuilds', `${platform}-${process.arch}.node`)
      : path.join('build', layout, 'better_sqlite3.node');
    const addon = path.join(source, relativeAddon);
    fs.mkdirSync(path.dirname(addon), { recursive: true });
    fs.copyFileSync(installedAddon, addon);
    write(source, 'build/Release/obj/addon.recipe', sourceRoot);
    write(source, 'build/future-metadata.txt', sourceRoot);
    write(sourceRoot, 'packages/server/src/index.ts', `
      import Database from 'better-sqlite3';
      const db = new Database(':memory:');
      try {
        if (db.prepare('SELECT 42 AS value').get().value !== 42) throw new Error('Bundled SQLite failed');
      } finally { db.close(); }
    `);
    const resources = path.join(directory, 'resources');
    const node = copyNodeRuntime(resources);

    await bundleServer(sourceRoot, resources);

    const serverDist = path.join(resources, 'server', 'dist');
    const packagedSqlite = path.join(serverDist, 'node_modules', 'better-sqlite3');
    assert.deepEqual(files(packagedSqlite).filter((filename) => !filename.startsWith('lib/')),
      ['LICENSE', relativeAddon.replaceAll(path.sep, '/'), 'package.json'].sort());
    verifyPackagedSqlite(node, serverDist);
    const result = spawnSync(node, ['--use-system-ca', path.join(serverDist, 'index.mjs')], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}
