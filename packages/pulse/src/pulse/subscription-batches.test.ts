import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { followTargets } from '../application/subscriptions.js';
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
