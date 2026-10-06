import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDENTIAL_BROKER_DELETE_PATH,
  CREDENTIAL_BROKER_RESOLVE_PATH,
  CredentialBrokerError,
  createCredentialBrokerClient,
  setCredentialBrokerToken,
} from './credential-broker.js';

const brokerEnv = {
  PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL: 'http://127.0.0.1:49152',
};
setCredentialBrokerToken('private-token');

test('ignores a broker token in the environment so child processes cannot inherit one', async () => {
  setCredentialBrokerToken(null);
  let called = false;
  const client = createCredentialBrokerClient({
    env: { ...brokerEnv, PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_TOKEN: 'env-token' },
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  });
  try {
    await assert.rejects(
      client.resolve('credential-ref'),
      (error: unknown) => error instanceof CredentialBrokerError && error.code === 'unavailable',
    );
    assert.equal(called, false);
  } finally {
    setCredentialBrokerToken('private-token');
  }
});

test('resolves a credential through the authenticated loopback broker', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ secret: 'pat-value' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(await client.resolve('credential-ref'), 'pat-value');
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, `http://127.0.0.1:49152${CREDENTIAL_BROKER_RESOLVE_PATH}`);
  assert.equal(request.init?.method, 'POST');
  assert.equal((request.init?.headers as Record<string, string>).Authorization, 'Bearer private-token');
  assert.deepEqual(JSON.parse(String(request.init?.body)), { credentialRef: 'credential-ref' });
});

test('constructs an authenticated credential delete request', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ removed: true }), { status: 200 });
    },
  });

  const oldRef = 'cred_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa';
  assert.equal(await client.delete(oldRef), true);

  assert.deepEqual(
    requests.map(({ url, init }) => ({
      url,
      method: init?.method,
      authorization: (init?.headers as Record<string, string>).Authorization,
      body: JSON.parse(String(init?.body)),
    })),
    [
      {
        url: `http://127.0.0.1:49152${CREDENTIAL_BROKER_DELETE_PATH}`,
        method: 'DELETE',
        authorization: 'Bearer private-token',
        body: { credentialRef: oldRef },
      },
    ],
  );
});

test('rejects a non-loopback broker URL before sending a request', async () => {
  let called = false;
  const client = createCredentialBrokerClient({
    env: {
      PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL: 'https://credential.example.test:443',
    },
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  });

  await assert.rejects(
    client.resolve('credential-ref'),
    (error: unknown) => error instanceof CredentialBrokerError && error.code === 'unavailable',
  );
  assert.equal(called, false);
});

test('reports a missing broker credential without returning response details', async () => {
  const client = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async () => new Response('internal vault details', { status: 404 }),
  });

  await assert.rejects(
    client.resolve('credential-ref'),
    (error: unknown) => error instanceof CredentialBrokerError
      && error.code === 'not_found'
      && !error.message.includes('internal vault details'),
  );
});

test('rejects a successful broker response that has no non-empty secret', async () => {
  const client = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async () => new Response(JSON.stringify({ secret: '' }), { status: 200 }),
  });

  await assert.rejects(
    client.resolve('credential-ref'),
    (error: unknown) => error instanceof CredentialBrokerError && error.code === 'invalid_response',
  );
});

test('rejects invalid deletion responses', async () => {
  const invalidDeleteClient = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async () => new Response(JSON.stringify({ removed: 'yes' }), { status: 200 }),
  });
  await assert.rejects(
    invalidDeleteClient.delete('cred_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'),
    (error: unknown) => error instanceof CredentialBrokerError && error.code === 'invalid_response',
  );
});

test('rejects oversized requests before contacting the broker', async () => {
  let called = false;
  const client = createCredentialBrokerClient({
    env: brokerEnv,
    fetchImpl: async () => {
      called = true;
      return new Response();
    },
  });

  await assert.rejects(
    client.resolve('x'.repeat(64 * 1024)),
    (error: unknown) => error instanceof CredentialBrokerError && error.code === 'unavailable',
  );
  assert.equal(called, false);
});
