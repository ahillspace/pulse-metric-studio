import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { finishObservedTableauResponse, logTableauEvent, observedTableauFetch, runWithTableauTelemetry, safeTableauAppPath, safeTableauPath, withTableauOperation } from './telemetry.js';

const dataDir = mkdtempSync(join(tmpdir(), 'pulse-telemetry-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = dataDir;
const { getJson, postJson, tableauFetch, MAX_CONCURRENT_TABLEAU_REQUESTS, TableauThrottleError } = await import('./rest-client.js');
const sessions = await import('./session.js');
const { closeDb } = await import('../db/index.js');
const { discoverRestApiVersion, patSignin } = await import('./signin.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; sessions.clearSession(); });
after(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });
type Record = { [key: string]: unknown };
const uuid = '11111111-1111-1111-1111-111111111111';
let identities = 0;
function session() { return { serverUrl: 'https://tableau.example.test', siteContentUrl: '', siteId: uuid, userId: `user-${++identities}`, token: 'SECRET-TOKEN', apiVersion: '3.27' }; }
function collect<T>(reqId: string, records: Record[], callback: () => T) { return runWithTableauTelemetry({ reqId, appMethod: 'POST', appPath: '/api/pulse/metrics/fork?filter=SECRET-FILTER', log: record => records.push(record) }, callback); }

test('one attempt per send includes throttle retries and identifies local no-send rejection', async () => {
  const owner = session();
  const records: Record[] = [];
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json({});
  await collect('retry', records, () => getJson(owner, '/api/-/pulse/definitions?filter=SECRET-FILTER'));
  const attempts = records.filter(record => record.event === 'tableau.attempt');
  assert.equal(attempts.length, calls);
  assert.deepEqual(attempts.map(record => [record.status, record.attempt, record.retryReason]), [[429, 1, null], [200, 2, 'throttle']]);
  assert.equal(attempts[0].retryAfter, '0');
  assert.equal(attempts[0].retryAfterMs, 0);
  assert.equal(attempts[0].callId, attempts[1].callId);
  assert.ok(attempts.every(record => record.path === '/api/-/pulse/definitions' && record.sent === true));
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }); };
  await assert.rejects(collect('first-429', records, () => getJson(owner, '/api/-/pulse/definitions')));
  const beforeLocal = calls;
  await assert.rejects(collect('local', records, () => getJson(owner, '/api/-/pulse/definitions', undefined, 100)));
  assert.equal(calls, beforeLocal);
  const local = records.find(record => record.reqId === 'local');
  assert.equal(local?.event, 'tableau.gate_rejected');
  assert.equal(local?.sent, false);
  assert.equal(local?.reason, 'throttle_deadline');
  assert.ok(Number(local?.holdMs) > 3_599_000);
  assert.equal(records.filter(record => record.event === 'tableau.attempt').length, calls);
});

test('completed shared holds report actual waited duration', async () => {
  const records: Record[] = [];
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({});
  await collect('held', records, () => getJson(session(), '/api/-/pulse/definitions'));
  const attempts = records.filter(record => record.event === 'tableau.attempt');
  assert.equal(attempts.length, calls);
  assert.deepEqual(attempts.map(record => [record.status, record.attempt, record.retryReason]), [[429, 1, null], [200, 2, 'throttle']]);
  const held = records.find(record => record.event === 'tableau.gate_wait' && record.attempt === 2 && Number(record.holdMs) > 0);
  assert.equal(held?.sent, false);
  assert.ok(Number(held?.waitedMs) >= 900);
  assert.equal(held?.callId, attempts[0].callId);
  assert.ok(Number(attempts[0].throttleHoldMs) >= 990);
});

test('authentication refresh and replay retain request identity and monotonic attempt numbers', async () => {
  const records: Record[] = [];
  const owner = session();
  owner.userId = uuid;
  const connection = sessions.saveConnection({ label: 'Telemetry', serverUrl: owner.serverUrl, siteContentUrl: '', patName: 'SECRET-PAT-NAME', patSecret: 'SECRET-PAT', storageKind: 'encrypted' });
  sessions.setSession(owner, { connectionId: connection.id, patSecret: 'SECRET-PAT' });
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).endsWith('/auth/signin')) return Response.json({ credentials: { token: 'NEW-SECRET-TOKEN', site: { id: uuid }, user: { id: uuid } } });
    return calls === 1 ? new Response('{}', { status: 401 }) : Response.json({});
  };
  await collect('auth', records, () => getJson(owner, '/api/-/pulse/definitions'));
  const attempts = records.filter(record => record.event === 'tableau.attempt');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(record => record.reqId === 'auth'));
  const requests = attempts.filter(record => record.path === '/api/-/pulse/definitions');
  assert.deepEqual(requests.map(record => [record.attempt, record.status, record.retryReason]), [[1, 401, null], [2, 200, 'authentication']]);
  assert.equal(requests[0].callId, requests[1].callId);
  assert.equal(attempts.find(record => String(record.path).endsWith('/auth/signin'))?.retryReason, 'authentication');
  assert.doesNotMatch(JSON.stringify(records), /SECRET|credentials|personalAccessToken/);
});

test('sign-in, discovery, network failures, and REST version fallback are observable', async () => {
  const records: Record[] = [];
  globalThis.fetch = async () => { throw new Error('SECRET-FILTER SECRET-TOKEN'); };
  await collect('network', records, () => assert.rejects(getJson(session(), '/api/-/pulse/definitions')));
  const network = records.filter(record => record.reqId === 'network' && record.event === 'tableau.attempt');
  assert.equal(network.length, 1);
  assert.equal(network[0].status, null);
  assert.equal(network[0].failure, 'network');
  globalThis.fetch = async (url) => String(url).endsWith('serverInfo')
    ? Response.json({ serverInfo: { restApiVersion: { number: '3.27' } } })
    : Response.json({ credentials: { token: 'SECRET-TOKEN', site: { id: uuid }, user: { id: uuid } } });
  await collect('connect', records, async () => {
    await discoverRestApiVersion('https://tableau.example.test');
    await patSignin({ serverUrl: 'https://tableau.example.test', siteContentUrl: '', apiVersion: '3.27', patName: 'SECRET-NAME', patSecret: 'SECRET-PAT' });
  });
  assert.equal(records.filter(record => record.reqId === 'connect' && record.event === 'tableau.attempt').length, 2);
  globalThis.fetch = async (url) => String(url).includes('/3.27/') ? new Response('{"error":{"code":"404003"}}', { status: 404 }) : Response.json({});
  await collect('version', records, () => getJson(session(), `/api/3.27/sites/${uuid}/groups`));
  const version = records.filter(record => record.reqId === 'version' && record.event === 'tableau.attempt');
  assert.deepEqual(version.map(record => [record.status, record.attempt, record.retryReason]), [[404, 1, null], [200, 2, 'version']]);
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
});

test('discovery redirects log every hop without Location values and retain a bounded GET redirect policy', async () => {
  const records: Record[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.redirect, 'manual');
    calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { Location: '/redirect?secret=SECRET-TOKEN' } })
      : calls === 2 ? new Response(null, { status: 303, headers: { Location: '/api/-/serverInfo?secret=SECRET-TOKEN' } })
      : Response.json({ serverInfo: { restApiVersion: { number: '3.28' } } });
  };
  assert.equal(await collect('redirects', records, () => discoverRestApiVersion('https://tableau.example.test')), '3.28');
  const redirects = records.filter(record => record.reqId === 'redirects' && record.event === 'tableau.attempt');
  assert.equal(redirects.length, calls);
  assert.deepEqual(redirects.map(record => [record.status, record.attempt, record.retryReason]), [[302, 1, null], [303, 2, 'redirect'], [200, 3, 'redirect']]);
  assert.equal(new Set(redirects.map(record => record.callId)).size, 1);
  assert.doesNotMatch(JSON.stringify(records), /SECRET|Location|location/);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: '/api/-/serverInfo' } }); };
  assert.equal(await collect('loop', records, () => discoverRestApiVersion('https://tableau.example.test')), '3.27');
  assert.equal(calls, 21, 'matches fetch maximum of twenty redirects');
  assert.equal(records.filter(record => record.reqId === 'loop' && record.event === 'tableau.attempt').length, calls);
});

test('central projection rejects arbitrary fields, unrecognized paths, unsafe IDs and headers', async () => {
  const records: Record[] = [];
  collect('privacy', records, () => {
    logTableauEvent({ event: 'tableau.get_or_create', metricId: 'SECRET-TOKEN', isMetricCreated: true, token: 'SECRET-TOKEN', body: 'SECRET-FILTER' } as Parameters<typeof logTableauEvent>[0]);
    logTableauEvent({ event: 'tableau.attempt', callId: uuid, attempt: 1, startedAt: Date.now(), method: 'POST', path: '/api/-/pulse/metrics/SECRET-FILTER?token=SECRET-TOKEN', status: 429, durationMs: 0, retryAfter: 'SECRET-TOKEN' });
  });
  assert.equal(records[0].metricId, '[redacted]');
  assert.equal(records[1].retryAfter, '[invalid]');
  assert.equal(records[1].path, '/api/-/pulse/metrics/[redacted]');
  assert.doesNotMatch(JSON.stringify(records), /SECRET|"body"|"token"/);
  assert.equal(safeTableauPath('/unrecognized/SECRET-FILTER'), '/[redacted]');
  assert.equal(safeTableauAppPath('/api/pulse/existing-metrics?filter=SECRET-FILTER'), '/api/pulse/existing-metrics');
  assert.equal(safeTableauAppPath('/api/pulse/metrics/:metricId/followers-detail'), '/api/pulse/metrics/:id/followers-detail');
  assert.equal(safeTableauPath(`/api/3.27/sites/${uuid}/users/${uuid}/groups?secret=value`), `/api/3.27/sites/${uuid}/users/${uuid}/groups`);
  for (const path of ['/api/-/pulse/insights/springboard', '/api/-/pulse/images/metricCard']) assert.equal(safeTableauPath(path), path);
  globalThis.fetch = async () => new Response('SECRET-RESPONSE-BODY', { status: 500 });
  await assert.rejects(collect('provider-body', records, () => getJson(session(), '/api/-/pulse/definitions')));
  assert.doesNotMatch(JSON.stringify(records), /SECRET|RESPONSE-BODY/);
});

for (const outcome of ['capacity grant', 'throttle refusal'] as const) {
  test(`a shared-identity ${outcome} retains the queued request's context and log sink`, async (t) => {
    const owner = session();
    const recordsA: Record[] = [];
    const recordsB: Record[] = [];
    const tracing = new AsyncLocalStorage<string>();
    const now = Date.now;
    let elapsed = 0;
    // Make capacity wait measurable without depending on wall-clock timer precision.
    t.mock.method(Date, 'now', () => now() + elapsed++);
    const run = <T>(reqId: string, records: Record[], callback: () => T) => tracing.run(reqId, () => runWithTableauTelemetry({
      reqId, appMethod: 'POST', appPath: '/api/pulse/metrics/fork?filter=SECRET-FILTER',
      log: record => records.push({ ...record, traceContext: tracing.getStore() }),
    }, () => withTableauOperation(reqId === 'A' ? 'fork_source' : 'dimensions_source', callback)));
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    let allStarted!: () => void;
    const started = new Promise<void>(resolve => { allStarted = resolve; });
    let releaseThrottle!: () => void;
    const throttled = new Promise<Response>(resolve => {
      releaseThrottle = () => resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }));
    });
    let sends = 0;
    globalThis.fetch = async () => {
      const send = ++sends;
      if (send === MAX_CONCURRENT_TABLEAU_REQUESTS) allStarted();
      if (send > MAX_CONCURRENT_TABLEAU_REQUESTS) return Response.json({});
      if (send === 1 && outcome === 'throttle refusal') return throttled;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { bodies.push(controller); } }));
    };
    const path = '/api/-/pulse/definitions?filter=SECRET-FILTER';
    const active = run('A', recordsA, () => Promise.allSettled(Array.from({ length: MAX_CONCURRENT_TABLEAU_REQUESTS }, () => getJson(owner, path))));
    await started;
    const queued = run('B', recordsB, () => getJson(owner, path));
    assert.equal(sends, MAX_CONCURRENT_TABLEAU_REQUESTS, 'the ninth request waits behind the same identity');
    const queuedResult = outcome === 'throttle refusal'
      ? assert.rejects(queued, (error: unknown) => error instanceof TableauThrottleError && !error.sent)
      : queued;
    try {
      if (outcome === 'throttle refusal') { releaseThrottle(); await queuedResult; }
    } finally {
      for (const body of bodies) { body.enqueue(new TextEncoder().encode('{}')); body.close(); }
    }
    const [activeResults] = await Promise.all([active, queuedResult]);
    assert.equal(activeResults.filter(result => result.status === 'rejected').length, outcome === 'throttle refusal' ? 1 : 0);
    assert.equal(sends, outcome === 'throttle refusal' ? MAX_CONCURRENT_TABLEAU_REQUESTS : MAX_CONCURRENT_TABLEAU_REQUESTS + 1);
    const gate = recordsB.find(record => record.event === (outcome === 'throttle refusal' ? 'tableau.gate_rejected' : 'tableau.gate_wait'));
    assert.ok(gate, 'the queued request logs admission in its own sink');
    assert.equal(gate.sent, false);
    assert.ok(Number(gate.waitedMs) > 0);
    if (outcome === 'capacity grant') {
      const attempt = recordsB.find(record => record.event === 'tableau.attempt');
      assert.ok(attempt);
      assert.equal(gate.callId, attempt.callId);
      assert.equal(gate.attempt, attempt.attempt);
    } else {
      assert.equal(gate.reason, 'throttle_deadline');
      assert.equal(recordsB.length, 1, 'local refusal has no provider attempt');
      assert.ok(Number(gate.holdMs) >= 3_599_000);
    }
    for (const [records, reqId, operation] of [[recordsA, 'A', 'fork_source'], [recordsB, 'B', 'dimensions_source']] as const) {
      assert.ok(records.length > 0);
      for (const record of records) {
        assert.equal(record.reqId, reqId);
        assert.equal(record.operation, operation);
        assert.equal(record.traceContext, reqId, 'the log sink sees the originating tracing context');
        assert.equal(record.appPath, '/api/pulse/metrics/fork');
        assert.equal(record.path, '/api/-/pulse/definitions');
      }
      assert.doesNotMatch(JSON.stringify(records), /SECRET/);
    }
  });
}

test('attempt completion includes body wait and logs once when the body fails', async () => {
  const records: Record[] = [];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, 30); } }));
  await collect('body', records, () => getJson(session(), '/api/-/pulse/definitions'));
  const body = records.filter(record => record.reqId === 'body' && record.event === 'tableau.attempt');
  assert.equal(body.length, 1);
  assert.ok(Number(body[0].durationMs) >= 20);
  assert.ok(Number(body[0].durationMs) > Number(body[0].headersMs));
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() {} }));
  await assert.rejects(collect('body-failed', records, () => postJson(session(), '/api/-/pulse/definitions', {}, { timeoutMs: 20 })));
  const failed = records.filter(record => record.reqId === 'body-failed' && record.event === 'tableau.attempt');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 200);
  await collect('complete', records, async () => {
    const response = await observedTableauFetch('https://tableau.example.test/api/-/pulse/definitions', {}, undefined, async () => Response.json({}));
    finishObservedTableauResponse(response);
    finishObservedTableauResponse(response);
  });
  assert.equal(records.filter(record => record.reqId === 'complete' && record.event === 'tableau.attempt').length, 1);
});

test('a queued deadline during a shared hold records the known throttle cause', async () => {
  const records: Record[] = [];
  const owner = session();
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({});
  // Seed the shared hold without retrying, then queue eight eligible requests.
  await collect('seed', records, () => tableauFetch(owner, '/api/-/pulse/definitions', { timeoutMs: 10 }));
  const waiters = Array.from({ length: 8 }, (_, index) => collect(`waiter-${index}`, records, () => getJson(owner, '/api/-/pulse/definitions')));
  await assert.rejects(collect('capacity', records, () => getJson(owner, '/api/-/pulse/definitions', undefined, 20)));
  const rejected = records.find(record => record.reqId === 'capacity');
  assert.equal(rejected?.event, 'tableau.gate_rejected');
  assert.equal(rejected?.reason, 'throttle_deadline');
  assert.equal(rejected?.sent, false);
  assert.ok(Number(rejected?.holdMs) > 0);
  await Promise.all(waiters);
  assert.equal(calls, 9);
});
