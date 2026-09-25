import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { discoverTests } from './run-tests.mjs';

test('new nested regression suites are discovered and a failing suite fails the runner', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-test-discovery-'));
  try {
    const nested = path.join(directory, 'tableau');
    fs.mkdirSync(nested);
    const fixture = path.join(nested, 'previously-omitted.test.mjs');
    fs.writeFileSync(fixture, "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('regression', () => assert.equal(1, 2));\n");
    assert.deepEqual(discoverTests(directory), [fixture]);
    const runner = fileURLToPath(new URL('./run-tests.mjs', import.meta.url));
    const failed = spawnSync(process.execPath, [runner, directory], { encoding: 'utf8' });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    fs.writeFileSync(fixture, "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('regression', () => assert.equal(1, 1));\n");
    const passed = spawnSync(process.execPath, [runner, directory], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
