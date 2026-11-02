import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function write(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-native-build-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('pulse-native-build-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source');
  const temporary = path.join(directory, 'temporary');
  const output = path.join(source, 'native-artifacts');
  fs.mkdirSync(temporary);
  for (const script of ['build-native.mjs', 'native-stage-dependencies.mjs', 'macos-compatibility.mjs', 'release-provenance.mjs']) {
    write(path.join(source, 'scripts', script), fs.readFileSync(path.join(root, 'scripts', script)));
  }
  write(path.join(source, 'package.json'), JSON.stringify({ version: '0.1.4', workspaces: [] }));
  write(path.join(source, '.gitignore'), 'node_modules/\nnative-artifacts/\npackages/**/dist/\n');
  write(path.join(source, 'package-lock.json'), '{}');
  write(path.join(source, 'tsconfig.base.json'), '{}');
  write(path.join(source, 'packages/web/dist/index.html'), 'current frontend');
  write(path.join(source, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'com.ahillspace.pulsemetricstudio' }));
  write(path.join(source, 'node_modules/vite/bin/vite.js'), '');
  write(path.join(source, 'node_modules/@tauri-apps/cli/tauri.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const put = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); };
    put(path.join(process.env.CARGO_TARGET_DIR, 'build-called'), 'yes');
    put(path.join(process.env.CARGO_TARGET_DIR, 'release/bundle/nsis/Studio_0.1.3_x64-setup.exe'), 'current installer');
    put(path.join(process.env.CARGO_TARGET_DIR, 'release/pulse-metric-studio.exe'), 'validation executable');
    if (!process.env.PULSE_TEST_MISSING_RESOURCE) put(path.join(process.cwd(), 'src-tauri/resources/server/dist/index.mjs'), 'current backend');
  `);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture Builder'], ['config', 'user.email', 'fixture-noreply@example.test'], ['add', '.'], ['commit', '-qm', 'Fixture source']]) {
    const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const platform = path.join(directory, 'platform.mjs');
  // Exercise the Windows artifact flow on every test host; no native toolchain runs.
  write(platform, `
    import fs from 'node:fs';
    import path from 'node:path';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    if (process.env.PULSE_TEST_CHANGE_SOURCE) {
      const copy = fs.cpSync;
      let changed = false;
      fs.cpSync = (...args) => {
        if (!changed) { changed = true; fs.writeFileSync(path.join(process.cwd(), 'new-source.txt'), 'changed during copy'); }
        return copy(...args);
      };
    }
    if (process.env.PULSE_TEST_FAIL_PROMOTION) {
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (path.basename(from).startsWith('.pulse-native-output-')) throw new Error('Simulated promotion failure');
        return rename(from, to);
      };
    }
    if (process.env.PULSE_TEST_FAIL_CLEANUP) {
      const remove = fs.rmSync;
      fs.rmSync = (directory, options) => {
        if (path.basename(directory).startsWith('.pulse-native-output-')) throw new Error('Simulated cleanup failure');
        return remove(directory, options);
      };
    }
  `);
  const run = (destination = output, extraEnv = {}, flags = []) => spawnSync(process.execPath,
    ['--import', pathToFileURL(platform).href, path.join(source, 'scripts/build-native.mjs'), ...flags, '--output', destination], {
      cwd: source,
      env: { ...process.env, TMP: temporary, TEMP: temporary, TMPDIR: temporary, ...extraEnv },
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
  const target = path.join(temporary, 'pulse-metric-studio-native-target');
  return { source, temporary, output, target, run };
}
function previousBuild(output) {
  write(path.join(output, 'build-evidence.json'), JSON.stringify({ identifier: 'com.ahillspace.pulsemetricstudio', validation: false }));
  write(path.join(output, 'nsis/Studio_0.1.0_x64-setup.exe'), 'previous version');
  write(path.join(output, 'msi/Studio_0.1.3_x64_en-US.msi'), 'stale same version');
}
function files(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter(file => fs.statSync(path.join(directory, file)).isFile()).sort();
}

test('native CLI collects only current outputs and retains the dependency cache', (t) => {
  const build = fixture(t);
  previousBuild(build.output);
  write(path.join(build.target, 'release/bundle/msi/Studio_0.1.3_x64_en-US.msi'), 'stale cached bundle');
  write(path.join(build.target, 'release/deps/cache'), 'dependency cache');
  const result = build.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(build.output), ['build-evidence.json', 'release-evidence.json', path.join('nsis', 'Studio_0.1.3_x64-setup.exe'), 'tauri.conf.json'].sort());
  const evidence = JSON.parse(fs.readFileSync(path.join(build.output, 'build-evidence.json'), 'utf8'));
  assert.deepEqual(evidence.installerArtifacts.map(item => item.path), [path.join('nsis', 'Studio_0.1.3_x64-setup.exe')]);
  assert.equal(fs.readFileSync(path.join(build.target, 'release/deps/cache'), 'utf8'), 'dependency cache');
  assert.equal(fs.existsSync(path.join(build.target, '.pulse-native-build.lock')), false);
  assert.equal(evidence.source.dirty, false);
  assert.match(evidence.source.commit, /^[a-f0-9]{40}$/);
  assert.match(evidence.source.contentSha256, /^[a-f0-9]{64}$/);
  const published = fs.readFileSync(path.join(build.output, 'release-evidence.json'), 'utf8');
  assert.equal(published.includes(build.source), false);
  assert.equal(published.includes(build.temporary), false);
  assert.equal(published.includes('stage'), false);
  assert.equal(published.includes('executable'), false);
});

test('failed artifact verification preserves the entire previous successful output', (t) => {
  const build = fixture(t);
  previousBuild(build.output);
  const before = files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]);
  const result = build.run(build.output, { PULSE_TEST_MISSING_RESOURCE: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]), before);
  assert.equal(fs.existsSync(path.join(build.target, '.pulse-native-build.lock')), false);
});

test('failed output promotion restores the previous successful build', (t) => {
  const build = fixture(t);
  previousBuild(build.output);
  const before = files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]);
  const result = build.run(build.output, { PULSE_TEST_FAIL_PROMOTION: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Simulated promotion failure/);
  assert.deepEqual(files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]), before);
  assert.equal(fs.existsSync(path.join(build.target, '.pulse-native-build.lock')), false);
  assert.equal(fs.readdirSync(build.source).some(name => name.startsWith('.pulse-native-output-') || name.startsWith('.pulse-native-previous-')), false);
});

test('output cleanup failure still releases native target ownership', (t) => {
  const build = fixture(t);
  previousBuild(build.output);
  const result = build.run(build.output, { PULSE_TEST_MISSING_RESOURCE: '1', PULSE_TEST_FAIL_CLEANUP: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Simulated cleanup failure/);
  assert.equal(fs.existsSync(path.join(build.target, '.pulse-native-build.lock')), false);
  assert.equal(fs.readFileSync(path.join(build.output, 'nsis/Studio_0.1.0_x64-setup.exe'), 'utf8'), 'previous version');
});

test('native output cannot replace source directories or unrelated nonempty directories', (t) => {
  const build = fixture(t);
  const unrelated = path.join(build.source, 'unrelated');
  write(path.join(unrelated, 'keep.txt'), 'keep');
  for (const destination of [build.source, path.join(build.source, 'packages'), unrelated]) {
    const result = build.run(destination);
    assert.notEqual(result.status, 0, destination);
    assert.match(result.stderr, /output|artifact/i);
  }
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(build.target, 'build-called')), false);
});

test('native output rejects a directory link before replacement', (t) => {
  const build = fixture(t);
  const unrelated = path.join(build.source, 'unrelated');
  write(path.join(unrelated, 'keep.txt'), 'keep');
  const linked = path.join(build.source, 'linked-artifacts');
  fs.symlinkSync(unrelated, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = build.run(linked);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(build.target, 'build-called')), false);
});

test('native builds refuse a target already owned by another invocation', (t) => {
  const build = fixture(t);
  write(path.join(build.target, '.pulse-native-build.lock'), String(process.pid));
  const result = build.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native build|lock/i);
  assert.equal(fs.existsSync(path.join(build.target, 'build-called')), false);
  assert.equal(fs.readFileSync(path.join(build.target, '.pulse-native-build.lock'), 'utf8'), String(process.pid));
});

test('a concurrent source edit during staging preserves previous output and releases the lock', (t) => {
  const build = fixture(t);
  previousBuild(build.output);
  const before = files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]);
  const result = build.run(build.output, { PULSE_TEST_CHANGE_SOURCE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source changed while staging/);
  assert.deepEqual(files(build.output).map(file => [file, fs.readFileSync(path.join(build.output, file), 'utf8')]), before);
  assert.equal(fs.existsSync(path.join(build.target, '.pulse-native-build.lock')), false);
  assert.equal(fs.existsSync(path.join(build.target, 'build-called')), false);
});

test('dirty development builds and isolated Windows validation retain source identity', (t) => {
  const build = fixture(t);
  write(path.join(build.source, 'new-source.txt'), 'untracked development source');
  const ordinary = build.run();
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(build.output, 'build-evidence.json'), 'utf8'));
  assert.equal(evidence.source.dirty, true);
  const validationOutput = path.join(build.source, 'validation-output');
  const validation = build.run(validationOutput, {}, ['--validation']);
  assert.equal(validation.status, 0, validation.stderr);
  const validationEvidence = JSON.parse(fs.readFileSync(path.join(validationOutput, 'build-evidence.json'), 'utf8'));
  assert.equal(validationEvidence.validation, true);
  assert.equal(validationEvidence.source.dirty, true);
  assert.equal(fs.existsSync(path.join(validationOutput, 'release-evidence.json')), false);
  assert.match(validationEvidence.identifier, /^com\.ahillspace\.pulsemetricstudio\.validation\./);
});
