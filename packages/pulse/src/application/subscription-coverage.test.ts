import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import { getFollowState } from './subscriptions.js';
import { defaultDependencies, type SubscriptionDependencies } from './registry-dependencies.js';
import { invalidateSubscriptionCoverage } from './subscription-coverage.js';

function fixture() {
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  return session;
}
test('huge site discovery costs one page plus missing target pages and never repeats counts or covered reads', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    followerCounts: async () => { assert.fail('Relationship detail must not request follower counts.'); },
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return input.metricId ? { subscriptions: [{ metricId: input.metricId, follower: { id: 'group', type: 'GROUP' } }], nextPageToken: null } : { subscriptions: [{ metricId: 'unrelated', follower: { id: 'private', type: 'USER' } }], nextPageToken: 'next' }; },
  };
  const first = await getFollowState(session, 'user', [], ['a', 'b', 'c'], { detail: true, selectedGroupId: 'group' }, dependencies);
  assert.deepEqual(calls, ['site', 'a', 'b', 'c']);
  assert.equal(first.groupFollowsByMetricId.a, true);
  assert.equal(first.availabilityByMetricId.a?.followerCountStatus, 'not_requested');
  await getFollowState(session, 'user', [], ['c', 'b', 'a'], { detail: true, selectedGroupId: 'another-group' }, dependencies);
  assert.equal(calls.length, 4);
  invalidateSubscriptionCoverage(session, ['b']);
  await getFollowState(session, 'user', [], ['a', 'b', 'c'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site', 'a', 'b', 'c', 'b']);
});

test('only explicitly qualified complete site coverage establishes absence and new IDs remain unrequested', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...defaultDependencies, siteNegativeCoverageQualified: true,
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site']);
  assert.equal(result.userFollowsByMetricId.a, false);
  await getFollowState(session, 'user', [], ['a', 'b', 'new'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site', 'new']);
});

test('unqualified complete site and failed target never infer negative follows', async () => {
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => { if (input.metricId) throw new Error('Permission denied.'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(fixture(), 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(result.userFollowsByMetricId.a, undefined);
  assert.equal(result.groupFollowsByMetricId.a, undefined);
  assert.equal(result.availabilityByMetricId.a?.relationshipStatus, 'unavailable');
});

test('first detail demand is capped at twenty pages with explicit retained continuation', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => { calls++; return input.metricId ? { subscriptions: [{ metricId: input.metricId, follower: { id: `person-${calls}`, type: 'USER' } }], nextPageToken: `token-${calls}` } : { subscriptions: [], nextPageToken: null }; },
  };
  const first = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.equal(calls, 20); assert.equal(first.coverage?.canLoadMore, true);
  assert.equal(first.userFollowsByMetricId.a, undefined);
  await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.equal(calls, 20, 'Partial coverage requires explicit continuation.');
  await getFollowState(session, 'user', [], ['a', 'b'], { detail: true, continueCoverage: true }, dependencies);
  assert.ok(calls > 20 && calls <= 40);
});
