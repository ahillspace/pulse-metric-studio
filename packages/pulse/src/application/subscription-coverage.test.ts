import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { getFollowState, followTargets, unfollowTargets } from './subscriptions.js';
import { defaultDependencies, type SubscriptionDependencies } from './registry-dependencies.js';
import { invalidateSubscriptionCoverage, subscriptionCoverage } from './subscription-coverage.js';

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

test('switching to personal detail never upgrades retained unqualified site absence', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => { calls++; if (input.metricId) throw new Error('Permission denied.'); return { subscriptions: [], nextPageToken: null }; },
  };
  await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  const personal = await getFollowState(session, 'user', [], ['a'], { detail: true, personalOnly: true }, dependencies);
  assert.equal(personal.userFollowsByMetricId.a, undefined);
  assert.equal(calls, 2);
});

test('record exhaustion is terminal and explains why continuation is unavailable', async () => {
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => ({ subscriptions: Array.from({ length: 2000 }, (_, index) => ({ metricId: input.metricId ?? 'a', follower: { id: `user-${index}`, type: 'USER' as const } })), nextPageToken: 'more' }),
  };
  const result = await getFollowState(fixture(), 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(result.coverage?.canLoadMore, false);
  assert.match(result.errors.join(' '), /limit/i);
});

for (const size of [2000, 2001]) for (const continuation of [false, true]) {
  test(`coverage bounds ${size} returned records with continuation ${continuation}`, async () => {
    const session = fixture(); let calls = 0;
    const dependencies: SubscriptionDependencies = { ...defaultDependencies,
      listSubscriptionPage: async (_session, input) => { calls++; return { subscriptions: Array.from({ length: size }, (_, index) => ({ metricId: input.metricId ?? 'a', follower: { id: `person-${index}`, type: 'USER' as const } })), nextPageToken: continuation ? 'more' : null }; },
    };
    const first = await subscriptionCoverage(session, ['a'], {}, dependencies);
    assert.equal(first.entries[0]!.subscriptions!.length, 2000);
    assert.equal(first.entries[0]!.complete, size === 2000 && !continuation);
    assert.equal(first.coverage.canLoadMore, false);
    if (size > 2000 || continuation) assert.match(first.entries[0]!.diagnostic!.message, /limit/i);
    const continued = await subscriptionCoverage(session, ['a'], { continueCoverage: true }, dependencies);
    assert.equal(calls, 2, 'A terminal scan never sends an extra page.');
    assert.equal(continued.entries[0]!.subscriptions!.length, 2000);
  });
}

for (const action of ['follow', 'unfollow'] as const) for (const outcome of ['success', 'failed', 'unknown'] as const) {
  test(`relationship coverage fences pending ${action} through ${outcome} completion`, async () => {
    const session = fixture(); let followed = action === 'unfollow', release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; }); const reads: string[] = [];
    const subscriptions = () => followed ? [{ id: 'subscription', metricId: 'a', follower: { id: 'user', type: 'USER' as const } }] : [];
    const write = async () => {
      started(); await pending;
      if (outcome === 'failed') throw new TableauError('Rejected', 400);
      followed = action === 'follow';
      if (outcome === 'unknown') throw new TableauError('Lost response', 0, '', 'network');
    };
    const dependencies: SubscriptionDependencies = { ...defaultDependencies,
      listSubscriptions: async () => subscriptions(),
      listSubscriptionPage: async (_session, input) => { if (!input.metricId) return { subscriptions: [], nextPageToken: null }; reads.push(input.metricId); return { subscriptions: input.metricId === 'a' ? subscriptions() : [], nextPageToken: null }; },
      createSubscriptions: async () => { await write(); return [{ metricId: 'a', targetId: 'user', targetType: 'USER', ok: true, alreadyExists: false }]; },
      deleteSubscription: write,
    };
    const command = (action === 'follow' ? followTargets : unfollowTargets)(session, { operations: [{ metricId: 'a', target: { id: 'user', kind: 'USER' } }] }, dependencies);
    await writing;
    await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
    release(); await command;
    const after = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
    assert.equal(after.userFollowsByMetricId.a, followed);
    assert.deepEqual(reads, ['a', 'b', 'a'], 'Only the affected metric is reacquired, including rejected and ambiguous writes.');
  });
}

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
