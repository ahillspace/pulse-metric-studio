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
  assert.equal(result.availabilityByMetricId.a?.canLoadMore, false);
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
    assert.equal(first.entries[0]!.canLoadMore, false);
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
  const continued = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true, continueCoverage: true }, dependencies);
  assert.ok(calls > 20 && calls <= 40);
  assert.equal(continued.availabilityByMetricId.a?.canLoadMore, false, 'twenty scanned pages are terminal for that metric');
  assert.equal(continued.availabilityByMetricId.b?.canLoadMore, true, 'a different metric retains its own continuation');
});

test('invalid repeated continuation is terminal for its metric', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => {
      calls++;
      return input.metricId ? { subscriptions: [{ metricId: input.metricId, follower: { id: 'user', type: 'USER' } }], nextPageToken: 'repeated' } : { subscriptions: [], nextPageToken: null };
    },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(calls, 3);
  assert.equal(first.userFollowsByMetricId.a, true);
  assert.equal(first.availabilityByMetricId.a?.canLoadMore, false);
  assert.match(first.errors.join(' '), /invalid/i);
  await getFollowState(session, 'user', [], ['a'], { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls, 3);
});

for (const rejectedTarget of ['site', 'a', 'legacy'] as const) {
  test(`authentication propagates immediately from ${rejectedTarget} coverage`, async () => {
    const auth = new TableauError('Authentication expired.', 401, '', 'auth');
    const calls: string[] = [];
    const dependencies: SubscriptionDependencies = { ...defaultDependencies,
      listSubscriptionPage: rejectedTarget === 'legacy' ? undefined : async (_session, input) => {
        const target = input.metricId ?? 'site'; calls.push(target);
        if (target === rejectedTarget) throw auth;
        return { subscriptions: [], nextPageToken: null };
      },
      listSubscriptions: async (_session, metricId) => { calls.push(metricId); throw auth; },
    };
    await assert.rejects(subscriptionCoverage(fixture(), ['a', 'b'], {}, dependencies), error => error === auth);
    assert.deepEqual(calls, rejectedTarget === 'site' ? ['site'] : rejectedTarget === 'a' ? ['site', 'a'] : ['a']);
  });
}

test('recoverable failed pages retain positive evidence and resume only on explicit demand', async () => {
  const session = fixture(); let calls = 0, recovering = false;
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => {
      calls++;
      if (!input.metricId) return { subscriptions: [], nextPageToken: null };
      if (!input.pageToken) return { subscriptions: [{ metricId: input.metricId, follower: { id: 'user', type: 'USER' } }], nextPageToken: 'last' };
      if (!recovering) throw new TableauError('Temporarily unavailable.', 503);
      return { subscriptions: [], nextPageToken: null };
    },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(first.userFollowsByMetricId.a, true);
  assert.equal(first.availabilityByMetricId.a?.canLoadMore, true);
  assert.equal(first.availabilityByMetricId.a?.relationshipStatus, 'partial');
  assert.match(first.errors.join(' '), /Temporarily unavailable/);
  await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(calls, 3, 'ordinary reads retain the partial result without retrying');
  recovering = true;
  const completed = await getFollowState(session, 'user', [], ['a'], { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls, 4);
  assert.equal(completed.userFollowsByMetricId.a, true);
  assert.equal(completed.availabilityByMetricId.a?.relationshipStatus, 'available');
  assert.equal(completed.availabilityByMetricId.a?.canLoadMore, false);
  assert.equal(completed.coverage?.canLoadMore, false);
});

test('each batch reports per-metric continuation without erasing earlier unresolved demand', async () => {
  const session = fixture(); const calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const firstIds = Array.from({ length: 200 }, (_, index) => `first-${index}`);
  const first = await getFollowState(session, 'user', [], firstIds, { detail: true }, dependencies);
  assert.equal(calls.length, 20);
  assert.equal(Object.values(first.availabilityByMetricId).filter(value => value.canLoadMore).length, 181);
  assert.equal(first.coverage?.canLoadMore, true);
  const second = await getFollowState(session, 'user', [], ['last-1', 'last-2', 'last-3', 'last-4', 'last-5'], { detail: true }, dependencies);
  assert.equal(calls.length, 25);
  assert.equal(second.coverage?.canLoadMore, false);
  assert.ok(Object.values(second.availabilityByMetricId).every(value => value.canLoadMore === false));
  const unresolvedIds = firstIds.filter(metricId => first.availabilityByMetricId[metricId]?.canLoadMore);
  const continued = await getFollowState(session, 'user', [], unresolvedIds, { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls.length, 45);
  assert.equal(Object.values(continued.availabilityByMetricId).filter(value => value.canLoadMore).length, 161);
  assert.ok(Object.values(continued.availabilityByMetricId).slice(0, 20).every(value => value.canLoadMore === false));
});

test('explicit refresh reacquires only the requested metrics after subscriptions change elsewhere', async () => {
  const session = fixture(), calls: string[] = [];
  let followers: Record<string, string[]> = { a: ['alice'], b: ['carol'] };
  const dependencies: SubscriptionDependencies = { ...defaultDependencies, siteNegativeCoverageQualified: true,
    listSubscriptionPage: async (_session, input) => {
      calls.push(input.metricId ?? 'site');
      const ids = input.metricId ? [input.metricId] : Object.keys(followers);
      return { subscriptions: ids.flatMap(metricId => (followers[metricId] ?? []).map(id => ({ metricId, follower: { id, type: 'USER' as const } }))), nextPageToken: null };
    },
  };
  const identities = (result: Awaited<ReturnType<typeof getFollowState>>, id: string) => result.userFollowerIdsByMetricId?.[id];
  const first = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.deepEqual([identities(first, 'a'), identities(first, 'b')], [['alice'], ['carol']]);
  followers = { a: ['bob'], b: ['dave'] };
  const reused = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(identities(reused, 'a'), ['alice'], 'ordinary demand reuses complete coverage');
  assert.deepEqual(calls, ['site']);
  const refreshed = await getFollowState(session, 'user', [], ['a'], { detail: true, refresh: true }, dependencies);
  assert.deepEqual(identities(refreshed, 'a'), ['bob'], 'explicit refresh returns the changed identities');
  assert.equal(refreshed.availabilityByMetricId.a?.followerIdsStatus, 'available');
  assert.deepEqual(calls, ['site', 'a']);
  const unrelated = await getFollowState(session, 'user', [], ['b'], { detail: true }, dependencies);
  assert.deepEqual(identities(unrelated, 'b'), ['carol'], 'unrequested metrics keep their coverage');
  assert.deepEqual(calls, ['site', 'a']);
});

test('an explicit refresh fences an older pending read for the same metric', async () => {
  const session = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const dependencies: SubscriptionDependencies = { ...defaultDependencies,
    listSubscriptionPage: async (_session, input) => {
      if (!input.metricId) return { subscriptions: [], nextPageToken: null };
      const read = ++reads;
      if (read === 1) await held;
      return { subscriptions: [{ metricId: 'a', follower: { id: read === 1 ? 'stale' : 'fresh', type: 'USER' as const } }], nextPageToken: null };
    },
  };
  const older = getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  while (reads === 0) await new Promise(resolve => setImmediate(resolve));
  const refreshed = await getFollowState(session, 'user', [], ['a'], { detail: true, refresh: true }, dependencies);
  release(); await older;
  assert.deepEqual(refreshed.userFollowerIdsByMetricId?.a, ['fresh']);
  const after = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(after.userFollowerIdsByMetricId?.a, ['fresh'], 'the late older page cannot replace refreshed coverage');
  assert.equal(reads, 2);
});
