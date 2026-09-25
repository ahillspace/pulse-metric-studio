import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRepoEnv } from './config.js';

test('server config loads the repository root .env from an npm workspace', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-config-'));
  const serverDir = path.join(fixtureRoot, 'packages', 'server');
  const configModule = path.join(fixtureRoot, 'packages', 'core', 'dist', 'config.js');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(path.dirname(configModule), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, '.env'), 'PULSE_METRIC_STUDIO_CONFIG_TEST_VALUE=from-repo-root\n');

  const originalCwd = process.cwd();
  const target: Record<string, string> = {};
  try {
    process.chdir(serverDir);
    const result = loadRepoEnv({ moduleUrl: pathToFileURL(configModule), processEnv: target });
    assert.equal(result.error, undefined);
    assert.equal(target.PULSE_METRIC_STUDIO_CONFIG_TEST_VALUE, 'from-repo-root');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
