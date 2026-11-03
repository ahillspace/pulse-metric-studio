import assert from 'node:assert/strict';
import http from 'node:http';
import { test, type TestContext } from 'node:test';
import { HttpLlmProvider } from './openai-compat.js';
import { LlmProviderError } from '../types.js';
import type { StoredLlmProfile } from '../profiles.js';

function profile(baseUrl: string, id = 'fixture-http'): StoredLlmProfile {
  return { id, label: 'Fixture HTTP', protocol: 'openai-chat', baseUrl, model: 'fixture-model',
    authMode: 'none', secret: null, headers: {}, region: '', awsProfile: '', command: '',
    credentialCommand: null, credentialCommandHint: null, allowPrivateNetwork: true, source: 'saved' };
}

async function fixture(t: TestContext, handle: (res: http.ServerResponse) => void) {
  let requests = 0;
  let received!: () => void;
  const headersReceived = new Promise<void>(resolve => { received = resolve; });
  const server = http.createServer((_req, res) => { requests++; handle(res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const configured = profile(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
  const provider = new HttpLlmProvider(configured, async (url, init) => { const response = await fetch(url, init); received(); return response; }, async () => {});
  return { provider, headersReceived, requests: () => requests };
}

function partial(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.flushHeaders();
  res.write('{"choices":[');
}

test('a successful-header body timeout is a typed provider timeout', async (t) => {
  const f = await fixture(t, partial);
  const operation = f.provider.complete({ messages: [], timeoutMs: 500 });
  const rejected = assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.code, 'provider_timeout');
    assert.equal(error.provider, 'fixture-http');
    assert.equal(error.model, 'fixture-model');
    assert.equal(error.retryable, true);
    return true;
  });
  await f.headersReceived;
  await rejected;
  assert.equal(f.requests(), 1);
});

test('a body connection failure is typed as provider unavailable', async (t) => {
  const f = await fixture(t, res => { partial(res); setTimeout(() => res.destroy(), 20); });
  await assert.rejects(f.provider.complete({ messages: [], timeoutMs: 3000 }), (error: unknown) => {
    assert.ok(error instanceof LlmProviderError);
    assert.equal(error.code, 'provider_unavailable');
    assert.equal(error.provider, 'fixture-http');
    assert.equal(error.model, 'fixture-model');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(f.requests(), 1);
});

for (const status of [401, 403, 429]) {
  test(`HTTP ${status} retains its classification when the error body fails`, async (t) => {
    const f = await fixture(t, res => {
      res.writeHead(status, { 'request-id': 'fixture-request' }); res.flushHeaders(); res.write('{');
      if (status === 403) setTimeout(() => res.destroy(), 20);
    });
    await assert.rejects(f.provider.complete({ messages: [], timeoutMs: 500 }), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.code, status === 429 ? 'provider_quota' : 'provider_authentication');
      assert.equal(error.provider, 'fixture-http');
      assert.equal(error.model, 'fixture-model');
      assert.equal(error.reference, 'fixture-request');
      return true;
    });
    assert.equal(f.requests(), 1);
  });
}

test('caller cancellation wins over a known error status', async (t) => {
  const f = await fixture(t, res => { res.writeHead(401); res.flushHeaders(); res.write('{'); });
  const controller = new AbortController();
  const reason = new Error('The caller canceled this operation.');
  const operation = f.provider.complete({ messages: [], timeoutMs: 3000, signal: controller.signal });
  const rejected = assert.rejects(operation, (error: unknown) => error === reason);
  await f.headersReceived;
  controller.abort(reason);
  await rejected;
  assert.equal(f.requests(), 1);
});

test('caller cancellation during body consumption retains its original reason', async (t) => {
  const f = await fixture(t, partial);
  const controller = new AbortController();
  const reason = new Error('The caller canceled this operation.');
  const operation = f.provider.complete({ messages: [], timeoutMs: 3000, signal: controller.signal });
  const rejected = assert.rejects(operation, (error: unknown) => error === reason);
  await f.headersReceived;
  controller.abort(reason);
  await rejected;
  assert.equal(f.requests(), 1);
});

test('fully consumed malformed and oversized bodies keep invalid-response classifications', async () => {
  for (const body of ['{bad json}', 'x'.repeat(2_000_001)]) {
    const response = new Response(body);
    const provider = new HttpLlmProvider(profile('https://fixture.example.test'), async () => response, async () => {});
    await assert.rejects(provider.complete({ messages: [] }), (error: unknown) => error instanceof LlmProviderError && error.code === 'invalid_provider_response');
    assert.equal(response.body?.locked, false, 'bounded readers release their stream lock');
  }
});

test('typed provider errors survive the transport boundary unchanged', async () => {
  const original = new LlmProviderError({ code: 'provider_quota', message: 'Fixture quota reached.', provider: 'fixture', model: 'fixture', retryable: true });
  const provider = new HttpLlmProvider(profile('https://fixture.example.test'), async () => { throw original; }, async () => {});
  await assert.rejects(provider.complete({ messages: [] }), (error: unknown) => error === original);
});
