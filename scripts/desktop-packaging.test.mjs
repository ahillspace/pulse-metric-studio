import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseDevArgs, resolveTauriInvocation } from './dev.mjs';
import { copyInstallers, copyNodeRuntime, runtimeFilename } from './copy-resources.mjs';
import { assertSupportedNode, validateNodeExecutable, verifyPackagedSqlite } from './node-runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('development accepts workspace or desktop mode and rejects extra arguments', () => {
  assert.deepEqual(parseDevArgs([]), { mode: 'workspace' });
  assert.deepEqual(parseDevArgs(['--desktop']), { mode: 'desktop' });
  assert.throws(() => parseDevArgs(['--desktop', 'other']), /Usage:/);
  assert.throws(() => parseDevArgs(['--unknown']), /Usage:/);
});

test('desktop launch invokes the local Tauri CLI through Node', () => {
  const invocation = resolveTauriInvocation(root);
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.argsPrefix[0], path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
});

test('Tauri packaging references existing icons and includes the bundled runtime', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(config.productName, 'Pulse Metric Studio');
  assert.equal(config.bundle.resources.includes('resources/runtime'), true);
  assert.equal(config.bundle.resources.includes('resources/installer'), true);
  for (const icon of config.bundle.icon) {
    assert.equal(fs.existsSync(path.join(root, 'src-tauri', icon)), true, icon);
  }
});

test('resource composition copies a runnable platform-specific Node executable', () => {
  assert.equal(runtimeFilename('win32'), 'node.exe');
  assert.equal(runtimeFilename('darwin'), 'node');
  assert.equal(runtimeFilename('linux'), 'node');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-runtime-test-'));
  try {
    const resources = path.join(temporary, 'resources');
    const destination = copyNodeRuntime(resources);
    assert.equal(destination, path.join(resources, 'runtime', runtimeFilename()));
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(process.execPath));
    validateNodeExecutable(destination);
    if (process.platform !== 'win32') assert.notEqual(fs.statSync(destination).mode & 0o111, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('resource composition bundles the installers the app updates itself with', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-installer-test-'));
  try {
    const copied = copyInstallers(path.join(temporary, 'resources'));
    assert.deepEqual(copied.map((file) => path.basename(file)), ['install.sh', 'install.ps1']);
    for (const file of copied) {
      assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(root, 'scripts', path.basename(file))));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('unsupported runtimes fail with the supported SQLite runtime floor', () => {
  for (const version of ['v20.20.2', '21.7.3', 'not-node']) {
    assert.throws(() => assertSupportedNode(version), /Node.js 22 or newer is required/);
  }
  for (const version of ['v22.23.2', '24.0.0', '25.6.1']) assertSupportedNode(version);
});

test('packaged SQLite check cannot fall back to a working repository dependency', () => {
  assert.throws(() => verifyPackagedSqlite(process.execPath, path.join(root, 'scripts')), /Packaged Node\/SQLite compatibility check failed/);
});


test('packaged desktop permits local IPC only and preserves product identity', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const capability = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8'));
  assert.equal(config.identifier, 'com.ahillspace.pulsemetricstudio');
  assert.equal(config.bundle.publisher, 'ahillspace');
  assert.equal(config.bundle.macOS.minimumSystemVersion, '11.0');
  assert.match(config.app.security.csp, /connect-src ipc: http:\/\/ipc.localhost/);
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.ok(capability.permissions.includes('pulse-api'));
  assert.ok(capability.permissions.includes('credential-broker'));
  assert.deepEqual(capability.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten', 'credential-broker', 'pulse-api', 'updater', { identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }, { url: 'http://*' }] }]);
});
