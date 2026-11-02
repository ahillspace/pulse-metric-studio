import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { captureSourceIdentity, publicReleaseEvidence } from './release-provenance.mjs';

function git(directory, ...args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-source-identity-test-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('pulse-source-identity-test-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.name', 'Fixture Builder');
  git(source, 'config', 'user.email', 'fixture-noreply@example.test');
  git(source, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(source, 'source.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(source, 'binary.bin'), Buffer.from([0, 13, 10, 1]));
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'Fixture source');
  return { directory, source };
}

test('Git-normalized source identities match CRLF and LF checkouts while preserving binary bytes', (t) => {
  const { directory, source } = fixture(t);
  const windows = path.join(directory, 'windows');
  git(directory, '-c', 'core.autocrlf=true', 'clone', '-q', '--no-local', source, windows);
  git(windows, 'config', 'core.autocrlf', 'true');
  assert.ok(fs.readFileSync(path.join(windows, 'source.txt'), 'utf8').includes('\r\n'));
  assert.deepEqual(captureSourceIdentity(source), captureSourceIdentity(windows));
  fs.writeFileSync(path.join(source, 'source.txt'), 'changed\n');
  fs.writeFileSync(path.join(windows, 'source.txt'), 'changed\r\n');
  fs.writeFileSync(path.join(source, 'new.txt'), 'untracked\n');
  fs.writeFileSync(path.join(windows, 'new.txt'), 'untracked\r\n');
  const first = captureSourceIdentity(source);
  const second = captureSourceIdentity(windows);
  assert.equal(first.dirty, true);
  assert.deepEqual(first, second);
  fs.writeFileSync(path.join(windows, 'binary.bin'), Buffer.from([0, 10, 1]));
  assert.notEqual(first.contentSha256, captureSourceIdentity(windows).contentSha256);
});

test('distinct dirty, deleted and untracked source contents never share HEAD-only identity', (t) => {
  const { source } = fixture(t);
  const clean = captureSourceIdentity(source);
  fs.writeFileSync(path.join(source, 'source.txt'), 'first dirty\n');
  const first = captureSourceIdentity(source);
  fs.writeFileSync(path.join(source, 'source.txt'), 'second dirty\n');
  const second = captureSourceIdentity(source);
  assert.equal(first.commit, second.commit);
  assert.equal(first.dirty, true);
  assert.equal(second.dirty, true);
  assert.notEqual(first.contentSha256, second.contentSha256);
  fs.unlinkSync(path.join(source, 'source.txt'));
  assert.notEqual(captureSourceIdentity(source).contentSha256, clean.contentSha256);
  fs.writeFileSync(path.join(source, 'new.txt'), 'new source');
  assert.notEqual(captureSourceIdentity(source).contentSha256, second.contentSha256);
});

test('public release evidence rejects absent provenance and retains only approved fields', () => {
  const raw = { source: { commit: 'a'.repeat(40), dirty: true, contentSha256: 'b'.repeat(64), privateField: 'private-marker' }, version: '0.1.4', platform: 'win32', arch: 'x64', node: 'v22.23.2', validation: false, stage: 'private-stage', executable: 'private-executable', installerArtifacts: [{ path: 'nsis/Studio_0.1.4_x64-setup.exe', size: 1, sha256: 'c'.repeat(64), privateField: 'private-artifact' }] };
  assert.doesNotMatch(JSON.stringify(publicReleaseEvidence(raw)), /private/);
  assert.throws(() => publicReleaseEvidence({ ...raw, source: undefined }), /source evidence/);
  assert.throws(() => publicReleaseEvidence({ ...raw, installerArtifacts: [{ ...raw.installerArtifacts[0], path: '../private.exe' }] }), /invalid installer/);
});
