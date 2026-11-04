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
  let failed!: (error: unknown) => void;
  const headersReceived = new Promise<void>((resolve, reject) => { received = resolve; failed = reject; });
  // Some tests observe only the operation; their readiness failure is still handled.
  void headersReceived.catch(() => {});
  const server = http.createServer((_req, res) => { requests++; handle(res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const configured = profile(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
  const provider = new HttpLlmProvider(configured, async (url, init) => {
    try { const response = await fetch(url, init); received(); return response; }
    catch (error) { failed(error); throw error; }
  }, async () => {});
  return { provider, headersReceived, requests: () => requests };
}

function partial(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.flushHeaders();
  res.write('{"choices":[');
}

test('fixture readiness rejects when a request times out before response headers', { timeout: 3000 }, async (t) => {
  const f = await fixture(t, () => {});
  const operation = f.provider.complete({ messages: [], timeoutMs: 100 });
  const [ready, completed] = await Promise.allSettled([f.headersReceived, operation]);
  assert.equal(f.requests(), 1);
  assert.equal(ready.status, 'rejected');
  assert.equal(completed.status, 'rejected');
  if (ready.status !== 'rejected' || completed.status !== 'rejected') return;
  assert.ok(completed.reason instanceof LlmProviderError);
  assert.equal(completed.reason.code, 'provider_timeout');
  assert.equal(completed.reason.cause, ready.reason, 'readiness reports the actual fetch failure');
  assert.equal(ready.reason.name, 'TimeoutError');
});

// An in-memory body leaves only the provider's unreferenced deadline timer pending.
// Node 22 ends the test file when nothing referenced remains, so the test owns a
// referenced handle until its assertions finish.
function holdEventLoop(t: TestContext): void {
  const handle = setInterval(() => {}, 1000);
  t.after(() => clearInterval(handle));
}

for (const [status, code] of [[200, 'provider_timeout'], [401, 'provider_authentication'], [429, 'provider_quota']] as const) {
  test(`HTTP ${status} body obeys the operation deadline when the fetch adapter does not propagate abort`, { timeout: 3000 }, async (t) => {
    holdEventLoop(t);
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }), { status, headers: { 'request-id': 'fixture-request' } });
    const provider = new HttpLlmProvider(profile('https://fixture.example.test'), async () => response, async () => {});
    await assert.rejects(provider.complete({ messages: [], timeoutMs: 30 }), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.code, code);
      if (status !== 200) assert.equal(error.reference, 'fixture-request');
      return true;
    });
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false, 'deadline cleanup releases the reader without waiting for adapter cancellation');
  });
}

test('caller cancellation wins during an abort-ignoring error body and preserves its reason', { timeout: 3000 }, async () => {
  let reading!: () => void;
  const bodyStarted = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    pull() { reading(); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { status: 401 });
  const provider = new HttpLlmProvider(profile('https://fixture.example.test'), async () => response, async () => {});
  const controller = new AbortController();
  const reason = new Error('The caller canceled this operation.');
  const rejected = assert.rejects(provider.complete({ messages: [], signal: controller.signal }), (error: unknown) => error === reason);
  await bodyStarted;
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

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
  await Promise.all([f.headersReceived, rejected]);
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
  await Promise.all([f.headersReceived.then(() => controller.abort(reason)), rejected]);
  assert.equal(f.requests(), 1);
});

test('caller cancellation during body consumption retains its original reason', async (t) => {
  const f = await fixture(t, partial);
  const controller = new AbortController();
  const reason = new Error('The caller canceled this operation.');
  const operation = f.provider.complete({ messages: [], timeoutMs: 3000, signal: controller.signal });
  const rejected = assert.rejects(operation, (error: unknown) => error === reason);
  await Promise.all([f.headersReceived.then(() => controller.abort(reason)), rejected]);
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
