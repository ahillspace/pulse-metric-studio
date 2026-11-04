import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import crypto from 'node:crypto';
import { stageRelease } from './stage-release.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/sh.exe') : 'sh';
function write(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value); }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-release-stage-test-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('pulse-release-stage-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source');
  for (const name of ['stage-release.sh', 'stage-release.mjs', 'release-provenance.mjs']) {
    if (fs.existsSync(path.join(root, 'scripts', name))) write(path.join(source, 'scripts', name), fs.readFileSync(path.join(root, 'scripts', name)));
  }
  write(path.join(source, 'package.json'), '{\n  "version": "0.1.4"\n}\n');
  for (const name of ['install.sh', 'install.ps1']) write(path.join(source, 'scripts', name), 'ahillspace/pulse-metric-studio\n');
  const output = path.join(directory, 'release');
  const run = (...args) => spawnSync(shell, [path.join(source, 'scripts/stage-release.sh'), ...args], { cwd: source, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { directory, source, output, run };
}

test('release staging rejects conflicting same-name installers before publishing output', (t) => {
  const build = fixture(t);
  const name = 'Pulse-Metric-Studio_0.1.4_x64-setup.exe';
  const first = path.join(build.directory, 'first', name);
  const second = path.join(build.directory, 'second', name);
  write(first, 'first build');
  write(second, 'different build');
  const result = build.run('--repo', 'example/release', build.output, first, second);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /conflicting installer/i);
  assert.ok(!fs.existsSync(build.output) || fs.readdirSync(build.output).length === 0);
});

function installer(build, directory, name, source = {}, extra = {}) {
  const filename = path.join(build.directory, directory, name);
  write(filename, `installer ${name}`);
  const data = fs.readFileSync(filename);
  const evidence = { schemaVersion: 1, source: { commit: 'a'.repeat(40), dirty: false, contentSha256: 'b'.repeat(64), ...source }, version: '0.1.4', platform: name.endsWith('.dmg') ? 'darwin' : 'win32', arch: name.includes('aarch64') ? 'arm64' : 'x64', node: 'v22.23.2', validation: false, installerArtifacts: [{ path: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }], ...extra };
  write(path.join(path.dirname(filename), 'release-evidence.json'), JSON.stringify(evidence));
  return filename;
}

test('release staging accepts matching cross-platform sources, sanitizes evidence, and preserves repo overrides', (t) => {
  const build = fixture(t);
  const windows = installer(build, 'windows', 'Pulse Metric Studio_0.1.4_x64-setup.exe', {}, { stage: 'private-stage-marker', executable: 'private-executable-marker', remote: 'private-remote-marker' });
  const mac = installer(build, 'mac', 'Pulse-Metric-Studio_0.1.4_aarch64.dmg');
  write(path.join(build.source, 'scripts/install.sh'), 'ahillspace/pulse-metric-studio\r\n');
  const result = build.run('--repo', 'example/release', build.output, windows, mac);
  assert.equal(result.status, 0, result.stderr);
  const evidence = fs.readFileSync(path.join(build.output, 'release-evidence.json'), 'utf8');
  assert.equal(JSON.parse(evidence).builds.length, 2);
  assert.doesNotMatch(evidence, /private-|stage|executable|remote/);
  assert.equal(fs.readFileSync(path.join(build.output, 'install.sh'), 'utf8'), 'example/release\n');
  assert.equal(fs.readFileSync(path.join(build.output, 'checksums.txt'), 'utf8').trim().split('\n').length, 2);
  assert.ok(fs.existsSync(path.join(build.output, 'Pulse-Metric-Studio_0.1.4_x64-setup.exe')));
});

test('release staging requires an explicit release repository before reading installers', (t) => {
  const build = fixture(t);
  const input = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe');
  for (const args of [[build.output, input], ['--repo'], ['--repo', 'not-a-repository', build.output, input]]) {
    const result = build.run(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /--repo/);
    assert.equal(fs.existsSync(build.output), false);
  }
});

test('release staging rejects different dirty content despite matching HEAD and dirty flags', (t) => {
  const build = fixture(t);
  const windows = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe', { dirty: true });
  const mac = installer(build, 'mac', 'Pulse-Metric-Studio_0.1.4_aarch64.dmg', { dirty: true, contentSha256: 'c'.repeat(64) });
  const result = build.run('--repo', 'example/release', build.output, windows, mac);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mixed source identities/);
  assert.equal(fs.existsSync(build.output), false);
});

for (const failure of ['missing', 'hash', 'version', 'validation', 'architecture']) {
  test(`release staging rejects ${failure} evidence before promoting files`, (t) => {
    const build = fixture(t);
    const input = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe', {}, failure === 'version' ? { version: '0.1.3' } : failure === 'validation' ? { validation: true } : failure === 'architecture' ? { arch: 'arm64' } : {});
    if (failure === 'missing') fs.unlinkSync(path.join(path.dirname(input), 'release-evidence.json'));
    if (failure === 'hash') fs.appendFileSync(input, 'changed');
    const result = build.run('--repo', 'example/release', build.output, input);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(build.output), false);
  });
}

test('release staging preserves an existing release output on failure', (t) => {
  const build = fixture(t);
  write(path.join(build.output, 'keep.txt'), 'previous release');
  const input = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe');
  const result = build.run('--repo', 'example/release', build.output, input);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(build.output, 'keep.txt'), 'utf8'), 'previous release');
});

test('failed release promotion restores an existing empty output and removes temporary staging', (t) => {
  const build = fixture(t);
  const input = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe');
  fs.mkdirSync(build.output);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(from).startsWith('.pulse-release-stage-') && !from.endsWith('-previous')) throw new Error('Simulated release promotion failure');
    return rename(from, to);
  };
  try { assert.throws(() => stageRelease(build.source, ['--repo', 'example/release', build.output, input]), /Simulated release promotion failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(build.output), []);
  assert.equal(fs.readdirSync(build.directory).some((name) => name.startsWith('.pulse-release-stage-')), false);
});

test('installer changes during copy fail verification before release promotion', (t) => {
  const build = fixture(t);
  const input = installer(build, 'windows', 'Pulse-Metric-Studio_0.1.4_x64-setup.exe');
  const copy = fs.copyFileSync;
  fs.copyFileSync = (from, to) => { copy(from, to); fs.appendFileSync(to, 'concurrent change'); };
  try { assert.throws(() => stageRelease(build.source, ['--repo', 'example/release', build.output, input]), /changed while release files were copied/); }
  finally { fs.copyFileSync = copy; }
  assert.equal(fs.existsSync(build.output), false);
  assert.equal(fs.readdirSync(build.directory).some((name) => name.startsWith('.pulse-release-stage-')), false);
});
