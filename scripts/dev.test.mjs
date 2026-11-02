import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_BUILD_GROUPS, DEV_WATCHERS, resolveNpmInvocation } from './dev.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('development startup builds workspace dependencies in dependency order', () => {
  assert.deepEqual(
    DEV_BUILD_GROUPS.map((group) => group.map(({ workspace }) => workspace)),
    [
      ['@pulse-metric-studio/shared'],
      ['@pulse-metric-studio/core'],
      ['@pulse-metric-studio/pulse'],
    ],
  );
});

test('development startup watches every compiled workspace dependency', () => {
  const watched = new Set(DEV_WATCHERS.map(({ workspace }) => workspace));
  for (const workspace of [
    '@pulse-metric-studio/shared',
    '@pulse-metric-studio/core',
    '@pulse-metric-studio/pulse',
  ]) {
    assert.equal(watched.has(workspace), true, `${workspace} must be watched`);
  }
});

test('development startup invokes npm through Node without a Windows command shell', () => {
  const invocation = resolveNpmInvocation({ npm_execpath: 'C:\\npm\\npm-cli.js' });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.argsPrefix, ['C:\\npm\\npm-cli.js']);
});

test('server development watches compiled output from every dependency workspace', () => {
  const serverPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'server', 'package.json'), 'utf8'));
  const command = serverPackage.scripts.dev;
  for (const workspace of ['shared', 'core', 'pulse']) {
    assert.match(command, new RegExp(`--include \\.\\./${workspace}/dist/`));
  }
});
