import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { assertTableauMutationAdmission, getJson, getTableauThrottleStatus, postJson, tableauFetch, tableauThrottleDelay, TableauError, TableauRequestGate, TableauThrottleError, type TableauSession } from './rest-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const session = (userId: string): TableauSession => ({ serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId, token: 'fixture-token', apiVersion: '3.27' });

test('zero Retry-After still has all four positive floors and bounded jitter', () => {
  assert.deepEqual([0, 1, 2, 3].map(retry => tableauThrottleDelay(0, retry, 0)), [1000, 2000, 4000, 8000]);
  assert.equal(tableauThrottleDelay(0, 3, 250), 8250);
  assert.equal(tableauThrottleDelay(36_000, 3, 0), 36_000);
  assert.equal(tableauThrottleDelay(36_000, 3, 250), 36_250);
});

test('cooldown admits one queued real probe, then restores eight body-lifetime permits', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const gate = new TableauRequestGate();
  gate.pause(1000);
  const sent: number[] = [];
  const finish: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 18 }, (_, id) => gate.run(async permit => {
    sent.push(id);
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => finish.push(resolve));
    active--;
    permit.status = 200;
  }, Date.now() + 30_000));
  t.mock.timers.tick(999);
  await flush();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(sent, [0]);
  assert.equal(gate.status().throttled, true);
  finish.shift()!();
  await flush();
  assert.equal(sent.length, 9);
  assert.equal(peak, 8);
  while (finish.length) { finish.splice(0).forEach(resolve => resolve()); await flush(); }
  await Promise.all(requests);
  assert.equal(sent.length, 18, 'the probe never adds a health request');
  assert.equal(gate.status().throttled, false);
});

test('an old inflight success and a stale probe cannot clear a newer cooldown generation', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const gate = new TableauRequestGate();
  let finishOld!: () => void;
  const old = gate.run(async permit => { await new Promise<void>(resolve => { finishOld = resolve; }); permit.status = 200; }, Date.now() + 30_000);
  await flush();
  gate.pause(1000);
  let finishProbe!: () => void;
  const probe = gate.run(async permit => { await new Promise<void>(resolve => { finishProbe = resolve; }); permit.status = 200; }, Date.now() + 30_000);
  t.mock.timers.tick(1000);
  await flush();
  gate.pause(5000);
  finishOld();
  finishProbe();
  await Promise.all([old, probe]);
  assert.equal(gate.status().retryAt, 106_000);
  let sent = false;
  const next = gate.run(async permit => { sent = true; permit.status = 200; }, Date.now() + 30_000);
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(sent, false);
  t.mock.timers.tick(1);
  await next;
  assert.equal(gate.status().throttled, false);
});

for (const outcome of ['network', 'cancelled', 'body-failure', 'authentication', 'terminal'] as const) {
  test(`a ${outcome} probe retains backoff and reassigns its lease`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
    const gate = new TableauRequestGate();
    gate.pause(1000);
    const cancellation = new AbortController();
    const first = gate.run(async permit => {
      if (outcome === 'authentication' || outcome === 'terminal') { permit.status = outcome === 'authentication' ? 401 : 403; return; }
      if (outcome === 'body-failure') permit.status = 200;
      if (outcome === 'cancelled') {
        await new Promise<void>((_resolve, reject) => cancellation.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
      }
      throw Error(outcome);
    }, Date.now() + 30_000, cancellation.signal).catch(error => error);
    let nextSent = false;
    const second = gate.run(async permit => { nextSent = true; permit.status = 200; }, Date.now() + 30_000);
    t.mock.timers.tick(1000);
    await flush();
    if (outcome === 'cancelled') cancellation.abort();
    await first;
    assert.equal(gate.status().retryAt, 102_000);
    assert.equal(nextSent, false);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(nextSent, false);
    t.mock.timers.tick(1);
    await second;
    assert.equal(gate.status().throttled, false);
  });
}

test('a cooldown beyond the original deadline rejects unsent work and permits a later probe', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const gate = new TableauRequestGate();
  gate.pause(36_000);
  let sends = 0;
  await assert.rejects(gate.run(async () => { sends++; }, Date.now() + 30_000), (error: unknown) => error instanceof TableauThrottleError && !error.sent && error.throttle.retryAt === 136_000);
  assert.equal(sends, 0);
  t.mock.timers.tick(36_000);
  assert.equal(gate.status().throttled, false, 'expiry without a queued probe allows a new eligible command');
  await gate.run(async permit => { sends++; permit.status = 204; }, Date.now() + 30_000);
  assert.equal(sends, 1);
});

test('queued cancellation and expiry never acquire a probe or strand the cohort', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const gate = new TableauRequestGate();
  gate.pause(1000);
  const cancellation = new AbortController();
  const cancelled = gate.run(async () => assert.fail('cancelled request sent'), Date.now() + 30_000, cancellation.signal);
  cancellation.abort();
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(gate.run(async () => assert.fail('expired request sent'), Date.now() + 500), TableauThrottleError);
  const next = gate.run(async permit => { permit.status = 200; }, Date.now() + 30_000);
  t.mock.timers.tick(1000);
  await next;
  assert.equal(gate.status().throttled, false);
});

test('real transport distinguishes sent provider rejection from unsent admission and scopes owner status', async () => {
  const owner = session('structured-throttle');
  let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({}, { status: 429, headers: { 'retry-after': '36' } }); };
  await assert.rejects(getJson(owner, '/api/-/pulse/metrics/fixture', undefined, 100), (error: unknown) => error instanceof TableauThrottleError && error.sent && error.throttle.retryAt >= Date.now() + 35_000);
  assert.throws(() => assertTableauMutationAdmission(owner), (error: unknown) => error instanceof TableauThrottleError && !error.sent);
  await assert.rejects(getJson(owner, '/api/-/pulse/metrics/fixture', undefined, 100), (error: unknown) => error instanceof TableauThrottleError && !error.sent);
  assert.equal(getTableauThrottleStatus(owner).throttled, true);
  assert.equal(getTableauThrottleStatus(session('other-owner')).throttled, false);
  assert.equal(sends, 1, 'status and local refusal do not contact Tableau');
});

test('actual transport applies zero-header retry floors through all four retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const sends: number[] = [];
  globalThis.fetch = async () => { sends.push(Date.now()); return Response.json({}, { status: 429, headers: { 'retry-after': '0' } }); };
  const result = getJson(session('zero-floors'), '/api/-/pulse/metrics/fixture').catch(error => error);
  await flush();
  for (const wait of [1000, 2000, 4000, 8000]) {
    t.mock.timers.tick(wait - 1);
    await flush();
    assert.equal(sends.length, [1000, 2000, 4000, 8000].indexOf(wait) + 1);
    t.mock.timers.tick(1);
    await flush();
  }
  assert.ok(await result instanceof TableauThrottleError);
  assert.deepEqual(sends, [100_000, 101_000, 103_000, 107_000, 115_000]);
});

test('REST version negotiation cannot reset the original four-throttle-retry budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  let sends = 0;
  let throttles = 0;
  globalThis.fetch = async () => {
    if (++sends === 2) return Response.json({ error: { code: '404003', summary: 'Unknown resource' } }, { status: 404 });
    throttles++;
    return Response.json({}, { status: 429, headers: { 'retry-after': '0' } });
  };
  const result = getJson(session('version-throttle-budget'), '/api/3.29/sites/site/groups').catch(error => error);
  await flush();
  // The conclusive 404 releases its probe with a conservative one-second wait.
  for (const wait of [1000, 1000, 2000, 4000, 8000]) { t.mock.timers.tick(wait); await flush(); }
  assert.ok(await result instanceof TableauThrottleError);
  assert.equal(throttles, 5);
  assert.equal(sends, 6, 'four rejected-write retries plus one required version negotiation');
});

test('a final 429 retains structured timing even when its optional diagnostic body breaks', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('broken diagnostic')); } }), { status: 429, headers: { 'retry-after': '36', validation_code: '429001' } });
  await assert.rejects(getJson(session('broken-throttle-diagnostic'), '/api/-/pulse/metrics/fixture', undefined, 100), (error: unknown) => error instanceof TableauThrottleError && error.sent && error.providerCode === '429001' && error.throttle.retryAt >= Date.now() + 35_000);
});

test('an expired response-body probe releases its lease without extending its original deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const owner = session('expired-body-probe');
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    if (sends === 1) return Response.json({}, { status: 429, headers: { 'retry-after': '0' } });
    if (sends === 2) return new Response(new ReadableStream({ cancel() {} }));
    return Response.json({ ok: true });
  };
  await tableauFetch(owner, '/seed', { timeoutMs: 100 });
  const expired = tableauFetch(owner, '/probe', { timeoutMs: 2000 }).catch(error => error);
  const queued = getJson(owner, '/next', undefined, 30_000);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(sends, 2);
  t.mock.timers.tick(1000);
  const failure = await expired;
  assert.ok(failure instanceof TableauError && failure.kind === 'network');
  assert.equal(failure.sent, true);
  assert.equal(Date.now(), 102_000);
  assert.equal(getTableauThrottleStatus(owner).retryAt, 103_000);
  assert.equal(sends, 2);
  t.mock.timers.tick(1000);
  assert.deepEqual(await queued, { ok: true });
  assert.equal(sends, 3);
});

test('a network failure on a write probe is never replayed and the next request can recover', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const owner = session('network-write-probe');
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init!.method!);
    if (methods.length === 1) return Response.json({}, { status: 429, headers: { 'retry-after': '0' } });
    if (methods.length === 2) throw Error('connection reset after write');
    return Response.json({ ok: true });
  };
  const write = postJson(owner, '/api/-/pulse/metrics:getOrCreate', {}).catch(error => error);
  await flush();
  const queued = getJson(owner, '/next');
  t.mock.timers.tick(1000);
  const failure = await write;
  assert.ok(failure instanceof TableauError && failure.kind === 'network');
  assert.equal(failure.sent, true);
  assert.deepEqual(methods, ['POST', 'POST']);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(methods.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(await queued, { ok: true });
  assert.deepEqual(methods, ['POST', 'POST', 'GET']);
});

test('capacity deadline and queued cancellation expose unsent outcomes before provider dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const owner = session('unsent-capacity-and-cancel');
  const activeCancellation = new AbortController();
  let sends = 0;
  globalThis.fetch = async () => { sends++; return new Response(new ReadableStream({ cancel() {} })); };
  const active = Array.from({ length: 8 }, (_, id) => tableauFetch(owner, `/active-${id}`, { signal: activeCancellation.signal }).catch(error => error));
  await flush();
  const cancellation = new AbortController();
  const cancelled = tableauFetch(owner, '/cancelled', { signal: cancellation.signal }).catch(error => error);
  cancellation.abort();
  const cancelError = await cancelled;
  assert.ok(cancelError instanceof TableauError && cancelError.sent === false);
  const expired = tableauFetch(owner, '/expired', { timeoutMs: 100 }).catch(error => error);
  t.mock.timers.tick(100);
  const deadlineError = await expired;
  assert.ok(deadlineError instanceof TableauError && deadlineError.sent === false);
  assert.equal(sends, 8);
  activeCancellation.abort();
  const sentFailures = await Promise.all(active);
  assert.ok(sentFailures.every(error => error instanceof TableauError && error.sent === true));
});
