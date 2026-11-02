import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { registerPulseRoutes } from './routes.js';
import { clearSubscriptionCaches, listUserGroupIds } from '../application/subscriptions.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
beforeEach(() => { setSession(session, { connectionId: 'connection', patSecret: '' }); clearSubscriptionCaches(); });
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); clearSubscriptionCaches(); });

for (const size of [2, 200, 405]) {
  test(`count summaries for ${size} metrics defer all membership and follower identity requests`, async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url.pathname);
      assert.ok(url.pathname.endsWith('subscriptions:batchGetMetricFollowerCounts'));
      return Response.json({ follower_counts: url.searchParams.get('metric_ids')!.split(',').filter((id) => id !== 'metric-0').map((metric_id) => ({ metric_id, follower_count: 3 })) });
    };
    const app = Fastify();
    registerPulseRoutes(app);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: Array.from({ length: size }, (_, index) => `metric-${index}`), detail: false } });
      assert.equal(response.statusCode, 200, response.body);
      const state = response.json();
      assert.deepEqual(state.userFollowsByMetricId, {});
      assert.deepEqual(state.userFollowerIdsByMetricId, {});
      assert.equal(state.availabilityByMetricId['metric-1'].relationshipStatus, 'not_requested');
      assert.equal(state.availabilityByMetricId['metric-0'].followerCountStatus, 'unavailable');
      assert.equal(state.followerCountsByMetricId['metric-0'], undefined);
      assert.equal(urls.length, Math.ceil(size / 200));
    } finally { await app.close(); }
  });
}

test('membership reads share only within one authenticated session generation', async () => {
  let reads = 0;
  globalThis.fetch = async () => { reads++; return Response.json({ groups: { group: [{ id: 'group', name: 'Audience' }] } }); };
  const [first, second] = await Promise.all([listUserGroupIds(session, 'user'), listUserGroupIds(session, 'user')]);
  first.length = 0;
  assert.equal(second.length, 1);
  assert.equal(reads, 1);
  setSession(session, { connectionId: 'connection', patSecret: '' });
  await listUserGroupIds(session, 'user');
  assert.equal(reads, 2);
});
