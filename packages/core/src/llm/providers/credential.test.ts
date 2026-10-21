import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearCredentialCache, credentialCommandEnv, resolveCredentialCommand, resolveProfileSecret, runCredentialCommand, setCredentialCommandApprover } from './credential.js';

beforeEach(() => {
  clearCredentialCache();
});

test('credential command output is cached within the TTL so the runner runs once', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return 'MINTED-TOKEN\n';
  };
  const now = () => 1_000;
  const first = await resolveCredentialCommand('mint', 'provider', 'model', runner, now);
  const second = await resolveCredentialCommand('mint', 'provider', 'model', runner, now);
  assert.equal(first, 'MINTED-TOKEN');
  assert.equal(second, 'MINTED-TOKEN');
  assert.equal(calls, 1);
});

test('credential command re-runs after the cache entry expires', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return `token-${calls}`;
  };
  let clock = 0;
  const now = () => clock;
  assert.equal(await resolveCredentialCommand('mint', 'provider', 'model', runner, now), 'token-1');
  clock = 60_001;
  assert.equal(await resolveCredentialCommand('mint', 'provider', 'model', runner, now), 'token-2');
  assert.equal(calls, 2);
});

test('credential command stdout is trimmed', async () => {
  const runner = async () => '  MINTED-TOKEN  \n';
  assert.equal(await resolveCredentialCommand('mint', 'provider', 'model', runner), 'MINTED-TOKEN');
});

test('empty credential command output is rejected as an authentication failure', async () => {
  const runner = async () => '   \n';
  await assert.rejects(
    () => resolveCredentialCommand('mint', 'provider', 'model', runner),
    (error: any) => error?.code === 'provider_authentication' && /produced no output/.test(error.message),
  );
});

test('a runner rejection propagates from resolveCredentialCommand', async () => {
  const runner = async () => {
    throw new Error('boom');
  };
  await assert.rejects(() => resolveCredentialCommand('mint', 'provider', 'model', runner), /boom/);
});

test('resolveProfileSecret prefers the credential command over a static secret', async () => {
  const runner = async () => 'MINTED-TOKEN';
  const token = await resolveProfileSecret(
    { secret: 'static-secret', credentialCommand: 'mint' },
    'provider',
    'model',
    runner,
  );
  assert.equal(token, 'MINTED-TOKEN');
});

test('resolveProfileSecret trims the static secret when no credential command is set', async () => {
  const runner = async () => {
    throw new Error('runner must not run');
  };
  const token = await resolveProfileSecret(
    { secret: '  static-secret  ', credentialCommand: '' },
    'provider',
    'model',
    runner,
  );
  assert.equal(token, 'static-secret');
});

test('credential commands never inherit app-internal environment variables', async () => {
  process.env.PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL = 'http://127.0.0.1:1';
  process.env.PULSE_METRIC_STUDIO_TEST_SECRET = 'internal';
  try {
    assert.deepEqual(Object.keys(credentialCommandEnv()).filter((name) => name.startsWith('PULSE_METRIC_STUDIO_')), []);
    const pathName = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH');
    assert.ok(pathName, 'The credential command inherits the executable search path.');
    assert.equal(credentialCommandEnv()[pathName], process.env[pathName]);
    const printed = await runCredentialCommand(
      `"${process.execPath}" -e "process.stdout.write(Object.keys(process.env).filter((n) => n.startsWith('PULSE_METRIC_STUDIO_')).join(',') || 'none')"`,
    );
    assert.equal(printed, 'none');
  } finally {
    delete process.env.PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL;
    delete process.env.PULSE_METRIC_STUDIO_TEST_SECRET;
  }
});

test('a timed-out credential command is stopped with everything it started', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-credential-'));
  const pidFile = path.join(directory, 'pid');
  try {
    await assert.rejects(runCredentialCommand(`sleep 30 & echo $! > "${pidFile}"; wait`, 500), /timed out/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop credential commands run only after native approval, asked once per command', async () => {
  const asked: string[] = [];
  let answer = false;
  setCredentialCommandApprover(async (command) => {
    asked.push(command);
    return answer;
  });
  let runs = 0;
  const runner = async () => {
    runs += 1;
    return 'MINTED';
  };
  try {
    await assert.rejects(resolveCredentialCommand('mint', 'provider', 'model', runner), /not allowed to run/);
    assert.equal(runs, 0);
    answer = true;
    assert.equal(await resolveCredentialCommand('mint', 'provider', 'model', runner, () => 0), 'MINTED');
    clearCredentialCache();
    assert.equal(await resolveCredentialCommand('mint', 'provider', 'model', runner, () => 0), 'MINTED');
    assert.deepEqual(asked, ['mint', 'mint']);
    assert.equal(runs, 2);
    setCredentialCommandApprover(async () => {
      throw new Error('broker down');
    });
    await assert.rejects(resolveCredentialCommand('other', 'provider', 'model', runner), /could not be approved/);
  } finally {
    setCredentialCommandApprover(null);
  }
});
