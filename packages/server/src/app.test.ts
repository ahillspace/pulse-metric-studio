import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmProviderError, TableauError } from '@pulse-metric-studio/core';
import { buildApp } from './app.js';

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
    for (const origin of ['http://localhost:4621', 'http://127.0.0.1:4621']) {
      const development = await app.inject({ method: 'POST', url: '/api/test/mutation', headers: { origin } });
      assert.equal(development.statusCode, 200, development.body);
      assert.equal(development.headers['access-control-allow-origin'], origin);
    }
    assert.equal(requestCount, 2);
    const serverOwnOrigin = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'http://127.0.0.1:4620', 'access-control-request-method': 'GET' } });
    assert.equal(serverOwnOrigin.headers['access-control-allow-origin'], 'http://127.0.0.1:4620');
    const arbitraryLoopback = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'http://127.0.0.1:61943', 'access-control-request-method': 'GET' } });
    assert.equal(arbitraryLoopback.headers['access-control-allow-origin'], undefined);
    const rejected = await app.inject({ method: 'OPTIONS', url: '/api/llm/profiles', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'PUT' } });
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    const mutation = await app.inject({ method: 'POST', url: '/api/test/mutation', headers: { origin: 'https://attacker.example' } });
    assert.equal(mutation.statusCode, 403);
    assert.equal(requestCount, 2);
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
    assert.deepEqual(response.json().error, {
      code: 'provider_authentication',
      message: 'Authorization: Bearer [redacted] was rejected.',
      provider: 'gateway',
      model: 'model-1',
      retryable: false,
      reference: 'provider-request-1',
    });
    assert.equal(response.json().message, 'Authorization: Bearer [redacted] was rejected.');
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
