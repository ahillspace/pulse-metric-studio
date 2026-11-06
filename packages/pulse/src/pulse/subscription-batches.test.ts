import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearSession, setSession, postJson, getJson, type TableauSession } from '@pulse-metric-studio/core';
import { defaultDependencies } from '../application/registry-dependencies.js';
import { followTargets, unfollowTargets } from '../application/subscriptions.js';
import Fastify from 'fastify';
import { registerPulseRoutes } from './routes.js';
const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
beforeEach(() => setSession(session, { connectionId: 'connection', patSecret: '' }));
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
const operations = [{ metricId: 'metric', target: { id: 'recipient-a', kind: 'USER' as const } }, { metricId: 'metric', target: { id: 'recipient-b', kind: 'USER' as const } }, { metricId: 'metric', target: { id: 'recipient-c', kind: 'GROUP' as const } }];

test('three mixed recipients on one metric use one supported POST and identity mapping', async () => {
  const requests: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ subscriptions: [{ follower: { group_id: 'recipient-c' } }, { follower: { user_id: 'recipient-a' } }, { follower: { user_id: 'recipient-b' } }] });
  };
  const results = await followTargets(session, { operations });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { metric_id: 'metric', followers: [{ user_id: 'recipient-a' }, { user_id: 'recipient-b' }, { group_id: 'recipient-c' }] });
  assert.deepEqual(results.map((result) => result.status), ['followed', 'followed', 'followed']);
});

test('a missing returned recipient remains unknown without replay', async () => {
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    posts++;
    return Response.json({ subscriptions: [{ follower: { user_id: 'recipient-b' } }] });
  };
  const results = await followTargets(session, { operations: operations.slice(0, 2) });
  assert.deepEqual(results.map((result) => result.status), ['unknown', 'followed']);
  assert.equal(posts, 1);
});

test('different metrics remain separate envelopes and duplicate recipients send once', async () => {
  const ids: string[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    const body = JSON.parse(String(init?.body));
    ids.push(body.metric_id);
    return Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) });
  };
  const results = await followTargets(session, { operations: [operations[0]!, operations[0]!, { ...operations[0]!, metricId: 'other-metric' }] });
  assert.deepEqual(ids, ['metric', 'other-metric']);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'followed'));
});

test('batch 409 confirms only recipients proven by subsequent identity evidence', async () => {
  let reads = 0;
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') {
      reads++;
      return Response.json({ subscriptions: reads === 1 ? [] : [{ follower: { user_id: 'recipient-b' } }] });
    }
    posts++;
    return Response.json({ error: 'Subscription already exists for this follower' }, { status: 409 });
  };
  const results = await followTargets(session, { operations: operations.slice(0, 2) });
  assert.deepEqual(results.map((result) => result.status), ['unknown', 'already_followed']);
  assert.equal(posts, 1);
});

for (const failure of ['network', 'timeout', 'auth'] as const) {
  test(`a ${failure} failure labels every sent recipient and leaves other metrics unattempted`, async () => {
    let posts = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'GET') return Response.json({ subscriptions: [] });
      posts++;
      if (failure === 'network') throw new TypeError('fetch failed');
      if (failure === 'timeout') throw new DOMException('The operation timed out.', 'AbortError');
      return Response.json({ error: 'invalid token' }, { status: 401 });
    };
    const results = await followTargets(session, { operations: [...operations.slice(0, 2), { ...operations[0]!, metricId: 'later-metric' }] });
    assert.deepEqual(results.map((result) => result.status), [failure === 'auth' ? 'failed' : 'unknown', failure === 'auth' ? 'failed' : 'unknown', 'not_attempted']);
    assert.equal(posts, 1);
  });
}

test('a conflict verification 401 leaves submitted recipients unknown and later metrics unsent', async () => {
  const calls: string[] = [];
  let posts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') { posts++; calls.push('POST'); return Response.json({ error: 'conflict' }, { status: 409 }); }
    calls.push(`GET ${url.searchParams.get('metric_id')}`);
    return posts ? Response.json({ error: { detail: 'The owning session ended.' } }, { status: 401, headers: { validation_code: '401001' } }) : Response.json({ subscriptions: [] });
  };
  const app = Fastify();
  registerPulseRoutes(app);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/pulse/follow', payload: { context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' }, operations: [operations[0], operations[2], { ...operations[1], metricId: 'later-metric' }] } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.deepEqual(result.results.map((entry: { status: string }) => entry.status), ['unknown', 'unknown', 'not_attempted']);
    assert.equal(result.terminated, true);
    assert.equal(result.stopped, true);
    assert.ok(result.results.every((entry: { code: string }) => entry.code === 'authentication_required'));
    assert.match(result.results[0].error, /401001/);
    assert.equal(posts, 1);
    assert.deepEqual(calls, ['GET metric', 'GET later-metric', 'POST', 'GET metric']);
  } finally { await app.close(); }
});

const context = (owner: TableauSession) => ({ connectionId: 'connection', serverUrl: owner.serverUrl, siteId: owner.siteId, datasourceLuid: 'datasource' });
const limited = (seconds = 1) => Response.json({ error: 'limited' }, { status: 429, headers: { 'Retry-After': String(seconds) } });

/** Follows a job started by `start` until it answers with its final response. */
async function finish(app: ReturnType<typeof Fastify>, start: { statusCode: number; body: string; json(): any }) {
  let response = start;
  if (response.statusCode === 200 && response.json().job) response = await app.inject({ method: 'GET', url: `/api/pulse/jobs/${response.json().job.id}` });
  for (let polls = 0; response.statusCode === 202 && polls < 200; polls++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    response = await app.inject({ method: 'GET', url: `/api/pulse/jobs/${response.json().job.id}` });
  }
  return response;
}

for (const action of ['follow', 'unfollow'] as const) test(`${action} started during a known cooldown waits for Tableau instead of refusing`, async () => {
  // A distinct owner isolates gate lifetime from other tests.
  const owner = { ...session, userId: `cooldown-${action}` }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  let limitedOnce = false;
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    if (!limitedOnce) { limitedOnce = true; return limited(); }
    const method = String(init?.method ?? 'GET'); calls.push(method);
    if (method === 'GET') return Response.json({ subscriptions: action === 'unfollow' ? [{ id: 'subscription', follower: { user_id: 'recipient-a' } }] : [] });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ subscriptions: [{ follower: { user_id: 'recipient-a' } }] });
  };
  await assert.rejects(postJson(owner, '/api/-/pulse/test', {}, { timeoutMs: 100 }));
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const started = await app.inject({ method: 'POST', url: `/api/pulse/${action}`, payload: { context: context(owner), operations: [operations[0]] } });
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.throttled, true);
    assert.equal(calls.length, 0, 'Nothing is sent while Tableau is limiting requests.');
    const response = await finish(app, started);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().results[0].status, action === 'follow' ? 'followed' : 'unfollowed');
  } finally { await app.close(); }
});

test('real follow route resends a throttled write until Tableau accepts it', async () => {
  const owner = { ...session, userId: 'sent-follow-throttle' }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    const body = JSON.parse(String(init?.body));
    if (++posts === 1) return limited();
    return Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) });
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const started = await app.inject({ method: 'POST', url: '/api/pulse/follow', payload: { context: context(owner), operations: [operations[0], { ...operations[1], metricId: 'later' }] } });
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.total, 2);
    const response = await finish(app, started);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().results.map((item: { status: string }) => item.status), ['followed', 'followed']);
    assert.equal(posts, 3, 'The throttled envelope is resent once; the later metric is sent once.');
  } finally { await app.close(); }
});

test('real unfollow route resends a throttled delete until Tableau accepts it', async () => {
  const owner = { ...session, userId: 'sent-unfollow-throttle' }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(String(init?.method));
    if (init?.method === 'GET') return Response.json({ subscriptions: [{ id: 'subscription', follower: { user_id: 'recipient-a' } }] });
    return calls.filter(call => call === 'DELETE').length === 1 ? limited() : new Response(null, { status: 204 });
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const response = await finish(app, await app.inject({ method: 'POST', url: '/api/pulse/unfollow', payload: { context: context(owner), operations: [operations[0]] } }));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().results.map((item: { status: string; sent: boolean }) => [item.status, item.sent]), [['unfollowed', true]]);
    assert.deepEqual(calls, ['GET', 'DELETE', 'DELETE']);
  } finally { await app.close(); }
});

test('a throttled subscription preflight waits and the batch completes', async () => {
  const owner = { ...session, userId: 'preflight-follow-throttle' }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  const calls: string[] = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(String(init?.method));
    if (calls.length === 1) return limited();
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    return Response.json({ subscriptions: [{ follower: { user_id: 'recipient-a' } }] });
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const response = await finish(app, await app.inject({ method: 'POST', url: '/api/pulse/follow', payload: { context: context(owner), operations: [operations[0]] } }));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().results[0].status, 'followed');
    assert.deepEqual(calls, ['GET', 'GET', 'POST']);
  } finally { await app.close(); }
});

test('cancelling a throttled follow keeps completed work and reports queued writes as not sent', async () => {
  const owner = { ...session, userId: 'cancel-follow-throttle' }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ subscriptions: [] });
    const body = JSON.parse(String(init?.body));
    if (++posts === 2) return limited(60);
    return Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) });
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const started = await app.inject({ method: 'POST', url: '/api/pulse/follow', payload: { context: context(owner), operations: [operations[0], { ...operations[1], metricId: 'later' }] } });
    assert.equal(started.statusCode, 202, started.body);
    const cancelled = await app.inject({ method: 'POST', url: `/api/pulse/jobs/${started.json().job.id}/cancel` });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().job.state, 'stopping', 'Cancel answers with the confirmed stop, not the batch result.');
    assert.equal(cancelled.json().job.stopReason, 'cancelled');
    const response = await finish(app, cancelled);
    const body = response.json();
    assert.deepEqual(body.results.map((item: { status: string; sent: boolean }) => [item.status, item.sent]), [['followed', true], ['not_attempted', false]]);
    assert.equal(body.results[1].code, 'batch_stopped');
    assert.match(body.results[1].error, /cancelled/);
    assert.equal(body.stopped, true);
    assert.equal(posts, 2, 'A write waiting out a throttle is never resent after Cancel.');
  } finally { await app.close(); }
});

test('a job is only visible to the session that started it', async () => {
  const owner = { ...session, userId: 'job-owner' }; setSession(owner, { connectionId: 'connection', patSecret: '' });
  globalThis.fetch = async (_input, init) => init?.method === 'GET' ? Response.json({ subscriptions: [] }) : limited(60);
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const started = await app.inject({ method: 'POST', url: '/api/pulse/follow', payload: { context: context(owner), operations: [operations[0]] } });
    assert.equal(started.statusCode, 202, started.body);
    const id = started.json().job.id;
    setSession({ ...session, userId: 'someone-else' }, { connectionId: 'connection', patSecret: '' });
    assert.equal((await app.inject({ method: 'GET', url: `/api/pulse/jobs/${id}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/pulse/jobs/${id}/cancel` })).statusCode, 404);
    setSession(owner, { connectionId: 'connection', patSecret: '' });
    const response = await finish(app, await app.inject({ method: 'POST', url: `/api/pulse/jobs/${id}/cancel` }));
    assert.equal(response.json().results[0].status, 'not_attempted');
    const late = await app.inject({ method: 'POST', url: `/api/pulse/jobs/${id}/cancel` });
    assert.equal(late.statusCode, 200, late.body);
    assert.equal(late.json().job.state, 'finished', 'Cancelling a finished job confirms there is nothing left to stop.');
  } finally { await app.close(); }
});
