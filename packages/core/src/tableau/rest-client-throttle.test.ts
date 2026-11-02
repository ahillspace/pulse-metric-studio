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
  assert.equal(retryAfterMs('3600', now), 30_000);
});
