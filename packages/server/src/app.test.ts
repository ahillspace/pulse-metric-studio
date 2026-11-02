import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { LlmProviderError, TableauError } from '@pulse-metric-studio/core';
import { buildApp } from './app.js';

/** Signs a request the way the native transport does. */
function signed(token: string, method: string, target: string, timestamp = Date.now()) {
  const nonce = randomBytes(32).toString('hex');
  return {
    'x-pulse-nonce': nonce,
    'x-pulse-timestamp': String(timestamp),
    'x-pulse-signature': createHmac('sha256', token).update(`request:${method}\n${target}\n${nonce}\n${timestamp}`).digest('hex'),
  };
}

test('packaged Pulse desktop requires private startup credentials', () => {
  const previous = process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER;
  process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER = 'com.ahillspace.pulsemetricstudio';
  try {
    assert.throws(() => buildApp(), /desktop authentication is required/);
  } finally {
    if (previous === undefined) delete process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER;
    else process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER = previous;
  }
});

test('desktop authentication rejects absent or wrong credentials before route effects and never exposes its secret', async () => {
  const token = 'a'.repeat(64);
  let effects = 0;
  const app = buildApp({
    registerPulseRoutes(instance) { instance.post('/api/pulse/test', async () => ({ count: ++effects })); },
  }, { desktopToken: token });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const replayed = signed(token, 'POST', '/api/pulse/test');
    const rejectedHeaders: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${token}` },
      signed('b'.repeat(64), 'POST', '/api/pulse/test'),
      signed(token, 'GET', '/api/pulse/test'),
      signed(token, 'POST', '/api/pulse/other'),
      signed(token, 'POST', '/api/pulse/test', Date.now() - 10 * 60_000),
      { origin: 'http://localhost:5173' },
    ];
    for (const headers of rejectedHeaders) {
      const result = await fetch(`${origin}/api/pulse/test`, { method: 'POST', headers });
      assert.equal(result.status, 401);
    }
    assert.equal(effects, 0);
    const successful = await fetch(`${origin}/api/pulse/test`, { method: 'POST', headers: replayed });
    assert.equal(successful.status, 200);
    assert.equal(effects, 1);
    assert.equal((await fetch(`${origin}/api/pulse/test`, { method: 'POST', headers: replayed })).status, 401, 'a signature works once');
    const hostile = await fetch(`${origin}/api/pulse/test`, { method: 'POST', headers: { ...signed(token, 'POST', '/api/pulse/test'), origin: 'https://attacker.example' } });
    assert.equal(hostile.status, 403);
    assert.equal(effects, 1);
    assert.equal((await fetch(`${origin}/api/desktop/bootstrap`, { headers: signed(token, 'GET', '/api/desktop/bootstrap') })).status, 404);
    const challenge = 'b'.repeat(64);
    const ready = await fetch(`${origin}/api/desktop/ready?challenge=${challenge}`, {
      headers: { 'x-pulse-proof': createHmac('sha256', token).update(`ready-request:${challenge}`).digest('hex') },
    });
    assert.equal(ready.status, 200);
    const text = await ready.text();
    assert.equal(text.includes(token), false);
    assert.deepEqual(JSON.parse(text), { ready: true, protocol: 1,
      proof: createHmac('sha256', token).update(`ready-response:${challenge}`).digest('hex') });
    const unauthenticatedReady = await fetch(`${origin}/api/desktop/ready?challenge=${challenge}`);
    assert.equal(unauthenticatedReady.status, 401);
    const transcript = await fetch(`${origin}/api/pulse/test`, {
      method: 'POST', headers: { ...signed(token, 'POST', '/api/pulse/test'), 'Content-Type': 'application/json' }, body: JSON.stringify('x'.repeat(3 * 1024 * 1024)),
    });
    assert.equal(transcript.status, 200);
    const oversized = await app.inject({
      method: 'POST', url: '/api/pulse/test', headers: { ...signed(token, 'POST', '/api/pulse/test'), 'Content-Type': 'application/json' }, payload: JSON.stringify('x'.repeat(16 * 1024 * 1024)),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(effects, 2);
  } finally { await app.close(); }
});

test('local server CORS permits configured origins and server own origin, rejects arbitrary loopback and external origins', async () => {
  let requestCount = 0;
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.post('/api/test/mutation', async () => {
        requestCount += 1;
        return { ok: true };
      });
    },
  });
  try {
    const allowed = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
    const serverOwnOrigin = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'http://127.0.0.1:4620', 'access-control-request-method': 'GET' } });
    assert.equal(serverOwnOrigin.headers['access-control-allow-origin'], 'http://127.0.0.1:4620');
    const arbitraryLoopback = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'http://127.0.0.1:61943', 'access-control-request-method': 'GET' } });
    assert.equal(arbitraryLoopback.headers['access-control-allow-origin'], undefined);
    const rejected = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'PUT' } });
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    const mutation = await app.inject({ method: 'POST', url: '/api/test/mutation', headers: { origin: 'https://attacker.example' } });
    assert.equal(mutation.statusCode, 403);
    assert.equal(requestCount, 0);
  } finally {
    await app.close();
  }
});

test('server returns structured sanitized LLM failures', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/llm-error', async () => {
        throw new LlmProviderError({
          code: 'provider_authentication',
          message: 'Authorization: Bearer very-secret-token was rejected.',
          provider: 'gateway',
          model: 'model-1',
          reference: 'provider-request-1',
        });
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/llm-error' });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('very-secret-token'), false);
    const sanitizedMessage = response.json().error.message;
    assert.match(sanitizedMessage, /^Authorization:.*\[redacted\]/);
    assert.deepEqual(response.json().error, {
      code: 'provider_authentication',
      message: sanitizedMessage,
      provider: 'gateway',
      model: 'model-1',
      retryable: false,
      reference: 'provider-request-1',
    });
    assert.equal(response.json().message, sanitizedMessage);
  } finally {
    await app.close();
  }
});

test('server surfaces TableauError provider failures with their real status and message', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/vds-error', async () => {
        throw new TableauError('boom', 502, 'vds detail');
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/vds-error' });
    assert.equal(response.statusCode, 502);
    const error = response.json().error;
    assert.equal(typeof error, 'string');
    assert.equal(error.includes('boom'), true);
    assert.equal(error.includes('vds detail'), true);
  } finally {
    await app.close();
  }
});

test('server maps auth-kind TableauError to 401', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/vds-auth', async () => {
        throw new TableauError('session expired', 401, 'unauthorized', 'auth');
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/vds-auth' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.includes('session expired'), true);
  } finally {
    await app.close();
  }
});

test('server surfaces an explicit 5xx statusCode error with its own message', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/fork-error', async () => {
        const err = Object.assign(new Error('dimensional fork failed'), { statusCode: 502 });
        throw err;
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/fork-error' });
    assert.equal(response.statusCode, 502);
    assert.equal(typeof response.json().error, 'string');
    assert.equal(response.json().error, 'dimensional fork failed');
  } finally {
    await app.close();
  }
});

test('server preserves 4xx statusCode errors surfacing their message (regression guard)', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/unprocessable', async () => {
        const err = Object.assign(new Error('invalid request'), { statusCode: 422 });
        throw err;
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/unprocessable' });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error, 'invalid request');
  } finally {
    await app.close();
  }
});

test('server hides the message of an unexpected error behind a generic 500 with a reference', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/test/unexpected', async () => {
        throw new Error('unexpected');
      });
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/test/unexpected' });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes('unexpected'), false);
    assert.equal(response.json().error.code, 'internal_error');
    assert.equal(typeof response.json().error.reference, 'string');
    assert.equal(response.json().error.reference.startsWith('err_'), true);
  } finally {
    await app.close();
  }
});

test('static HTML responses disable caching with the current static plugin contract', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('Tableau diagnostics redact credential-shaped provider details', async () => {
  const app = buildApp({
    registerPulseRoutes(instance) {
      instance.get('/api/pulse/provider-failure', async () => { throw new TableauError('Provider rejected request', 502, 'Authorization: Bearer private-token'); });
    },
  });
  try {
    const response = await app.inject('/api/pulse/provider-failure');
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.includes('private-token'), false);
    assert.match(response.json().error, /redacted/);
  } finally { await app.close(); }
});

test('HTTP development host listens after construction and caller route registration with built web assets', async () => {
  const app = buildApp();
  app.get('/__test/ready', async () => ({ ready: true }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.listen({ port: 0, host: '127.0.0.1' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Host never became ready.')), 5000); }),
    ]);
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await (await fetch(`${origin}/__test/ready`)).json(), { ready: true });
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/api/not-mounted`)).status, 404);
  } finally { clearTimeout(timeout); await app.close(); }
});
