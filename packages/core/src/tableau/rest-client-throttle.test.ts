import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getJson, MAX_CONCURRENT_TABLEAU_REQUESTS, postJson, retryAfterMs, TableauError, type TableauSession } from './rest-client.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
let identities = 0;
// Throttling is shared per Tableau identity, so each test uses its own user.
function session(): TableauSession {
  return { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: `user-${++identities}`, token: 'test', apiVersion: '3.29' };
}
const throttled = (retryAfter = '0') => new Response('{}', { status: 429, headers: { 'Retry-After': retryAfter } });

test('a throttled request is retried after Tableau permits it', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? throttled() : Response.json({ ok: true }));
  assert.deepEqual(await getJson(session(), '/api/-/pulse/definitions'), { ok: true });
  assert.equal(calls, 2);
});

test('a throttled create is retried because Tableau rejected it before processing', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? throttled() : Response.json({ definition: { metadata: { id: 'd' } } }));
  assert.deepEqual(await postJson(session(), '/api/-/pulse/definitions', {}), { definition: { metadata: { id: 'd' } } });
  assert.equal(calls, 2);
});

test('persistent throttling stops retrying and reports the 429', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return throttled(); };
  await assert.rejects(getJson(session(), '/api/-/pulse/definitions'),
    (error: unknown) => error instanceof TableauError && error.status === 429);
  assert.ok(calls > 1 && calls <= 5, `expected bounded retries, saw ${calls} calls`);
});

test('a 429 pauses every request for the same identity until Retry-After elapses', async () => {
  const identity = session();
  let first = true;
  let throttledAt = 0;
  const startedAfterThrottle: number[] = [];
  globalThis.fetch = async () => {
    if (first) { first = false; throttledAt = Date.now(); return throttled('1'); }
    if (throttledAt) startedAfterThrottle.push(Date.now());
    return Response.json({});
  };
  const throttledRequest = getJson(identity, '/api/-/pulse/definitions/a/metrics');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all([throttledRequest, getJson(identity, '/api/-/pulse/definitions/b/metrics')]);
  assert.equal(startedAfterThrottle.length, 2);
  for (const startedAt of startedAfterThrottle) assert.ok(startedAt - throttledAt >= 950, `request resumed after ${startedAt - throttledAt}ms`);
});

test('requests for one identity never exceed the concurrency limit', async () => {
  const identity = session();
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return Response.json({});
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT_TABLEAU_REQUESTS * 3 }, (_, index) => getJson(identity, `/api/-/pulse/metrics/${index}`)));
  assert.equal(peak, MAX_CONCURRENT_TABLEAU_REQUESTS);
});

test('Retry-After accepts seconds and HTTP dates and falls back when absent', () => {
  const now = Date.parse('2026-10-21T23:00:00Z');
  assert.equal(retryAfterMs('3', now), 3000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 23:00:05 GMT', now), 5000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 22:59:00 GMT', now), 0);
  assert.equal(retryAfterMs(null, now), 2000);
  assert.equal(retryAfterMs('soon', now), 2000);
  assert.equal(retryAfterMs('3600', now), 3_600_000);
});

test('provider Retry-After beyond the local deadline returns unavailable without an early retry', async () => {
  const identity = session();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return throttled('3600'); };
  await assert.rejects(getJson(identity, '/api/-/pulse/definitions', undefined, 10),
    (error: unknown) => error instanceof TableauError && error.status === 429);
  assert.equal(calls, 1);
  await assert.rejects(getJson(identity, '/api/-/pulse/definitions', undefined, 10),
    (error: unknown) => error instanceof TableauError && error.status === 429);
  assert.equal(calls, 1, 'the identity gate also honors the provider minimum for new callers');
});

test('the last throttling response still defers other requests for that identity', async () => {
  const identity = session();
  let calls = 0;
  globalThis.fetch = async () => throttled(++calls < 5 ? '0' : '3600');
  await assert.rejects(getJson(identity, '/api/-/pulse/definitions'));
  assert.equal(calls, 5);
  await assert.rejects(getJson(identity, '/api/-/pulse/definitions', undefined, 10));
  assert.equal(calls, 5);
});

test('REST version negotiation makes forward progress and commits only a successful candidate', async () => {
  const identity = session();
  const paths: string[] = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return new Response('{"error":{"code":"404003"}}', { status: 404 });
  };
  await assert.rejects(getJson(identity, '/api/3.29/sites/site/groups'), (error: unknown) => error instanceof TableauError && error.status === 404);
  assert.equal(identity.apiVersion, '3.29');
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.length <= 6);
  paths.length = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return path.includes('/3.25/') ? Response.json({ ok: true })
      : new Response('{"error":{"code":"404003"}}', { status: 404 });
  };
  assert.deepEqual(await getJson(identity, '/api/3.29/sites/site/groups'), { ok: true });
  assert.equal(identity.apiVersion, '3.25');
  assert.equal(new Set(paths).size, paths.length);
});
