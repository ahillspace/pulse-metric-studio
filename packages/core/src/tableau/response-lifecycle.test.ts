import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { deleteReq, getJson, postJson, tableauFetch, TableauError, type TableauSession } from './rest-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const owner = (userId: string): TableauSession => ({ serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId, token: 'fixture-token', apiVersion: '3.27' });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await pause(2);
  assert.ok(check(), 'fixture reached its expected request state');
}

test('a 429 installs the shared cooldown before waking an already queued request', async () => {
  const session = owner('queued-throttle');
  const held: Array<(response: Response) => void> = [];
  const dispatched: Array<{ path: string; at: number }> = [];
  globalThis.fetch = async (input) => {
    dispatched.push({ path: new URL(String(input)).pathname, at: Date.now() });
    if (dispatched.length <= 8) return new Promise<Response>((resolve) => held.push(resolve));
    return Response.json({ ok: true });
  };
  const active = Array.from({ length: 8 }, (_, i) => getJson(session, `/active-${i}`));
  await until(() => held.length === 8);
  const queued = getJson(session, '/queued');
  const throttledAt = Date.now();
  held[0](Response.json({}, { status: 429, headers: { 'retry-after': '1' } }));
  try {
    await pause(40);
    assert.equal(dispatched.some((request) => request.path === '/queued'), false, 'the queued request observes the provider cooldown');
  } finally {
    for (const resolve of held.slice(1)) resolve(Response.json({ ok: true }));
    await Promise.all([...active, queued]);
  }
  assert.ok(dispatched.find((request) => request.path === '/queued')!.at - throttledAt >= 950);
});

test('the eight-request limit covers response bodies until their bounded reads complete', async () => {
  const session = owner('streamed-bodies');
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let dispatched = 0;
  let released = false;
  globalThis.fetch = async () => {
    dispatched++;
    if (released) return Response.json({ ok: true });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { bodies.push(controller); } }));
  };
  const requests = Array.from({ length: 24 }, (_, i) => getJson(session, `/stream-${i}`, undefined, 2000));
  await until(() => dispatched >= 8);
  try {
    await pause(25);
    assert.equal(dispatched, 8, 'headers do not release a live response body permit');
  } finally {
    released = true;
    for (const body of bodies) { body.enqueue(new TextEncoder().encode('{"ok":true}')); body.close(); }
    await Promise.all(requests);
  }
  assert.equal(dispatched, 24);
});

test('real HTTP responses with flushed headers retain capacity until their bodies finish', async () => {
  const held: ServerResponse[] = [];
  let released = false;
  let received = 0;
  const server = createServer((_request, response) => {
    received++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    if (released) response.end('{"ok":true}');
    else held.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = { ...owner('real-streams'), serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const requests = Array.from({ length: 24 }, (_, i) => getJson(session, `/stream-${i}`, undefined, 2000));
  try {
    await until(() => held.length >= 8);
    await pause(25);
    assert.equal(received, 8);
  } finally {
    released = true;
    for (const response of held) response.end('{"ok":true}');
    await Promise.all(requests);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
  assert.equal(received, 24);
});

test('status-only mutation bodies finish cancellation before releasing capacity', async () => {
  const session = owner('delayed-cancellation');
  const finishCancellation: Array<() => void> = [];
  let dispatched = 0;
  globalThis.fetch = async () => {
    if (++dispatched > 8) return new Response(null, { status: 204 });
    return new Response(new ReadableStream({ cancel() { return new Promise<void>((resolve) => finishCancellation.push(resolve)); } }));
  };
  const active = Array.from({ length: 8 }, (_, i) => deleteReq(session, `/api/-/pulse/metrics/${i}`));
  await until(() => finishCancellation.length === 8);
  const queued = deleteReq(session, '/api/-/pulse/metrics/queued');
  try {
    await pause(25);
    assert.equal(dispatched, 8, 'a pending cancellation retains its permit');
    finishCancellation[0]();
    await until(() => dispatched === 9);
  } finally {
    for (const finish of finishCancellation) finish();
    await Promise.all([...active, queued]);
  }
});

for (const status of [200, 404]) {
  test(`a confirmed status-only DELETE ${status} ignores an irrelevant broken or oversized body`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(Error('irrelevant body disconnected')); } }), { status, headers: { 'content-length': '999999999' } });
    };
    await deleteReq(owner(`delete-${status}`), '/api/-/pulse/metrics/exact');
    assert.equal(calls, 1, 'a confirmed mutation is never replayed for body cleanup');
  });
}

test('unresponsive status-only cancellation is bounded by the original deadline and aborts its request', async () => {
  const session = owner('cancel-deadline');
  let aborted = false;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    init!.signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
    return calls > 1 ? new Response(null, { status: 204 }) : new Response(new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }));
  };
  const response = await tableauFetch(session, '/confirmed', { method: 'DELETE', timeoutMs: 40, responseBody: { discardOnSuccess: true } });
  assert.equal(response.status, 200, 'confirmed headers remain successful when cleanup reaches its deadline');
  assert.equal(aborted, true);
  assert.equal((await tableauFetch(session, '/next')).status, 204);
  assert.equal(calls, 2);
});

test('body failure releases its permit and never replays a successful POST', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"definition":')); controller.error(Error('connection reset')); } }));
  };
  await assert.rejects(postJson(owner('post-body-failure'), '/api/-/pulse/definitions', {}), (error: unknown) => error instanceof TableauError && error.kind === 'network');
  assert.equal(calls, 1);
});

test('body limits cancel the original stream and retain provider headers on ordinary HTTP failures', async () => {
  let cancelled = 0;
  globalThis.fetch = async (input) => String(input).endsWith('/large')
    ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12)); }, cancel() { cancelled++; } }))
    : Response.json({ error: { summary: 'Permission denied' } }, { status: 403, statusText: 'Forbidden', headers: { validation_code: '403004' } });
  await assert.rejects(getJson(owner('bounded-body'), '/large', undefined, 2000, 4), /permitted size/);
  assert.equal(cancelled, 1);
  await assert.rejects(getJson(owner('bounded-body'), '/denied'), (error: unknown) => error instanceof TableauError && error.status === 403 && error.providerCode === '403004');
});

test('body deadlines cancel a stalled stream without dispatching a POST again', async () => {
  let cancelled = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  };
  await assert.rejects(postJson(owner('body-deadline'), '/write', {}, { timeoutMs: 35 }), (error: unknown) => error instanceof TableauError && error.kind === 'network' && /timed out/.test(error.message));
  assert.equal(cancelled, 1);
  assert.equal(calls, 1);
});

test('caller cancellation removes a queued request without taking a permit or sending it', async () => {
  const session = owner('cancel-queued');
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { bodies.push(controller); } }));
  };
  const active = Array.from({ length: 8 }, (_, i) => getJson(session, `/active-${i}`, undefined, 2000));
  await until(() => bodies.length === 8);
  const cancellation = new AbortController();
  const queued = tableauFetch(session, '/queued', { signal: cancellation.signal, timeoutMs: 2000 });
  cancellation.abort();
  try {
    await assert.rejects(queued, /cancelled/);
    assert.equal(calls, 8);
  } finally {
    for (const body of bodies) { body.enqueue(new TextEncoder().encode('{}')); body.close(); }
    await Promise.all(active);
  }
});

test('caller cancellation closes a live response body and allows the next request', async () => {
  let cancelled = 0;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response(new ReadableStream({ cancel() { cancelled++; } }))
    : new Response(null, { status: 204 });
  const cancellation = new AbortController();
  const session = owner('cancel-body');
  const reading = tableauFetch(session, '/stalled', { signal: cancellation.signal, timeoutMs: 2000 });
  await until(() => calls === 1);
  cancellation.abort();
  await assert.rejects(reading, /cancelled/);
  assert.equal(cancelled, 1);
  assert.equal((await tableauFetch(session, '/next')).status, 204);
});

test('version fallback inspects a 404 before an accepted status-only outcome', async () => {
  const session = owner('version-discard');
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return calls.length === 1 ? Response.json({ error: { code: '404003', summary: 'Unknown resource' } }, { status: 404 }) : new Response(null, { status: 204 });
  };
  assert.equal((await tableauFetch(session, '/api/3.27/resource', { method: 'DELETE', responseBody: { discardOnSuccess: true, discardOnStatuses: [404] } })).status, 204);
  assert.equal(session.apiVersion, '3.26');
  assert.equal(calls.length, 2);
});

test('final throttling retains its bounded diagnostic body and response metadata', async () => {
  globalThis.fetch = async () => Response.json({ error: { summary: 'Rate limited' } }, { status: 429, statusText: 'Provider cooldown', headers: { 'retry-after': '60', validation_code: '429001' } });
  const response = await tableauFetch(owner('final-throttle'), '/read', { timeoutMs: 250 });
  assert.equal(response.status, 429);
  assert.equal(response.statusText, 'Provider cooldown');
  assert.equal(response.headers.get('validation_code'), '429001');
  assert.deepEqual(await response.json(), { error: { summary: 'Rate limited' } });
});

for (const status of [204, 205, 304]) {
  test(`buffering preserves a null response body for HTTP ${status}`, async () => {
    globalThis.fetch = async () => new Response(null, { status });
    const response = await tableauFetch(owner(`null-${status}`), '/null');
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
  });
}

for (const failure of ['stalled', 'disconnected', 'oversized'] as const) {
  test(`simultaneous 401 ${failure} bodies cannot block the shared authentication refresh`, async (t) => {
    const { config } = await import('../config.js');
    const { closeDb } = await import('../db/index.js');
    const sessions = await import('./session.js');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-auth-body-'));
    config.dataDir = directory;
    config.dbPath = path.join(directory, 'fixture.db');
    t.after(() => { sessions.clearSession(); closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
    const session = owner(`auth-${failure}`);
    const profile = sessions.saveConnection({ label: 'Fixture', serverUrl: session.serverUrl, siteContentUrl: '', patName: 'fixture', storageKind: 'encrypted', patSecret: 'fixture-secret' });
    sessions.setSession(session, { connectionId: profile.id, patSecret: 'fixture-secret' });
    let signins = 0;
    let rejected = 0;
    let accepted = 0;
    const oldRequests: AbortSignal[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/auth/signin')) {
        signins++;
        return Response.json({ credentials: { token: 'fresh-token', site: { id: session.siteId }, user: { id: session.userId } } });
      }
      if (new Headers(init?.headers).get('X-Tableau-Auth') === 'fresh-token') { accepted++; return Response.json({ ok: true }); }
      rejected++;
      oldRequests.push(init!.signal!);
      return new Response(new ReadableStream({ start(controller) { if (failure === 'disconnected') controller.error(Error('diagnostic reset')); } }), { status: 401, headers: failure === 'oversized' ? { 'content-length': '999999999' } : {} });
    };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => getJson(session, `/read-${i}`, undefined, 1500)));
    assert.ok(results.every((result) => (result as { ok: boolean }).ok));
    assert.deepEqual({ signins, rejected, accepted }, { signins: 1, rejected: 8, accepted: 8 });
    assert.ok(oldRequests.every((signal) => signal.aborted), 'retired responses are closed before their permits are returned');
  });
}

for (const failure of ['stalled', 'disconnected', 'oversized'] as const) {
  test(`a conclusive 403 keeps its permission classification when its diagnostic body is ${failure}`, async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(new ReadableStream({ start(controller) { if (failure === 'disconnected') controller.error(Error('diagnostic reset')); } }), { status: 403, headers: { validation_code: '403004', ...(failure === 'oversized' ? { 'content-length': '999999999' } : {}) } });
    };
    await assert.rejects(getJson(owner(`permission-body-${failure}`), '/denied', undefined, 35, failure === 'oversized' ? 4 : undefined), (error: unknown) => error instanceof TableauError && error.status === 403 && error.kind === 'http' && error.providerCode === '403004');
    assert.equal(requests, 1);
  });
}
