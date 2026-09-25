import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { clearCredentialCache, resolveCredentialCommand, resolveProfileSecret } from './credential.js';

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
