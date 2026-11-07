import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { getFollowState, followTargets, unfollowTargets } from './subscriptions.js';
import { defaultDependencies, type SubscriptionDependencies } from './registry-dependencies.js';
import { invalidateSubscriptionCoverage, subscriptionCoverage, SUBSCRIPTION_CALLS_PER_REQUEST, SUBSCRIPTION_READ_CONCURRENCY } from './subscription-coverage.js';
import { PULSE_FOLLOW_DETAIL_BATCH_LIMIT } from '@pulse-metric-studio/shared';

/** Tests never reach Tableau: unless a test supplies counts, every count is unavailable and coverage falls back to reads. */
const isolated: SubscriptionDependencies = { ...defaultDependencies,
  followerCounts: async (_session, metricIds) => ({ countsByMetricId: {}, errorsByMetricId: Object.fromEntries(metricIds.map(id => [id, { message: 'Counts are not part of this test.' }])) }),
};
function fixture() {
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  return session;
}
test('huge site discovery costs one page plus missing target pages, reads counts once per request, and never repeats covered reads', async () => {
  const session = fixture(), calls: string[] = [], countReads: string[][] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async (session, metricIds) => { countReads.push(metricIds); return isolated.followerCounts(session, metricIds); },
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return input.metricId ? { subscriptions: [{ metricId: input.metricId, follower: { id: 'group', type: 'GROUP' } }], nextPageToken: null } : { subscriptions: [{ metricId: 'unrelated', follower: { id: 'private', type: 'USER' } }], nextPageToken: 'next' }; },
  };
  const first = await getFollowState(session, 'user', [], ['a', 'b', 'c'], { detail: true, selectedGroupId: 'group' }, dependencies);
  assert.deepEqual(calls, ['site', 'a', 'b', 'c']);
  assert.equal(first.groupFollowsByMetricId.a, true);
  assert.equal(first.availabilityByMetricId.a?.followerCountStatus, 'unavailable');
  assert.deepEqual(countReads, [['a', 'b', 'c']], 'one count read per detail request, for exactly its metrics');
  await getFollowState(session, 'user', [], ['c', 'b', 'a'], { detail: true, selectedGroupId: 'another-group' }, dependencies);
  assert.equal(calls.length, 4);
  invalidateSubscriptionCoverage(session, ['b']);
  await getFollowState(session, 'user', [], ['a', 'b', 'c'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site', 'a', 'b', 'c', 'b']);
});

test('only explicitly qualified complete site coverage establishes absence and new IDs remain unrequested', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated, siteNegativeCoverageQualified: true,
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site']);
  assert.equal(result.userFollowsByMetricId.a, false);
  await getFollowState(session, 'user', [], ['a', 'b', 'new'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site', 'new']);
});

test('unqualified complete site and failed target never infer negative follows', async () => {
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => { if (input.metricId) throw new Error('Permission denied.'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(fixture(), 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(result.userFollowsByMetricId.a, undefined);
  assert.equal(result.groupFollowsByMetricId.a, undefined);
  assert.equal(result.availabilityByMetricId.a?.relationshipStatus, 'unavailable');
});

test('switching to personal detail never upgrades retained unqualified site absence', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => { calls++; if (input.metricId) throw new Error('Permission denied.'); return { subscriptions: [], nextPageToken: null }; },
  };
  await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  const personal = await getFollowState(session, 'user', [], ['a'], { detail: true, personalOnly: true }, dependencies);
  assert.equal(personal.userFollowsByMetricId.a, undefined);
  assert.equal(calls, 2);
});

test('record exhaustion is terminal and explains why continuation is unavailable', async () => {
  const dependencies: SubscriptionDependencies = { ...isolated,
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
    const dependencies: SubscriptionDependencies = { ...isolated,
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
    const dependencies: SubscriptionDependencies = { ...isolated,
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

test('targeted scans stop at their own page limit, breadth first, within one request', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => { calls++; return input.metricId ? { subscriptions: [{ metricId: input.metricId, follower: { id: `person-${calls}`, type: 'USER' } }], nextPageToken: `token-${calls}` } : { subscriptions: [], nextPageToken: null }; },
  };
  const first = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.equal(calls, 41, 'one site page and twenty pages for each metric');
  assert.equal(first.coverage?.canLoadMore, false);
  assert.equal(first.userFollowsByMetricId.a, undefined);
  assert.match(first.errors.join(' '), /limit/i);
  await getFollowState(session, 'user', [], ['a', 'b'], { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls, 41, 'a terminal scan never sends an extra page');
});

test('the per-request budget stops oversized demand fairly and explains how to continue', async () => {
  const session = fixture(); const pages = new Map<string, number>(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => {
      calls++;
      if (!input.metricId) return { subscriptions: [], nextPageToken: null };
      const page = (pages.get(input.metricId) ?? 0) + 1; pages.set(input.metricId, page);
      return { subscriptions: [{ metricId: input.metricId, follower: { id: `person-${page}`, type: 'USER' } }], nextPageToken: page < 2 ? `token-${page}` : null };
    },
  };
  const ids = Array.from({ length: 150 }, (_, index) => `metric-${index}`);
  const first = await getFollowState(session, 'user', [], ids, { detail: true }, dependencies);
  assert.equal(calls, SUBSCRIPTION_CALLS_PER_REQUEST);
  assert.ok(ids.every(id => (pages.get(id) ?? 0) >= 1), 'every metric gets its first page before any metric gets a second');
  assert.ok(ids.filter(id => pages.get(id) === 1).every(id => first.availabilityByMetricId[id]?.canLoadMore === true));
  assert.ok(ids.some(id => pages.get(id) === 1) && ids.some(id => pages.get(id) === 2), 'the budget runs out part way through the second round');
  assert.ok(ids.filter(id => pages.get(id) === 1).every(id => first.availabilityByMetricId[id]?.diagnostics.some(diagnostic => /Load more/.test(diagnostic.message))), 'a stopped metric says why on its row');
  const continued = await getFollowState(session, 'user', [], ids, { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls, 1 + ids.length * 2);
  assert.ok(ids.every(id => continued.availabilityByMetricId[id]?.relationshipStatus === 'available'));
  assert.equal(continued.coverage?.canLoadMore, false);
});

test('a full detail batch completes in one request with bounded concurrent reads', async () => {
  const session = fixture(); let calls = 0, active = 0, peak = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return { subscriptions: input.metricId === 'metric-7' ? [{ metricId: 'metric-7', follower: { id: 'user', type: 'USER' } }] : [], nextPageToken: null };
    },
  };
  const ids = Array.from({ length: PULSE_FOLLOW_DETAIL_BATCH_LIMIT }, (_, index) => `metric-${index}`);
  const result = await getFollowState(session, 'user', [], ids, { detail: true }, dependencies);
  assert.equal(calls, 1 + ids.length);
  assert.ok(peak > 1 && peak <= SUBSCRIPTION_READ_CONCURRENCY, `peak ${peak}`);
  assert.equal(result.coverage?.canLoadMore, false);
  assert.ok(ids.every(id => result.availabilityByMetricId[id]?.relationshipStatus === 'available'));
  assert.equal(result.userFollowsByMetricId['metric-7'], true);
  assert.equal(result.userFollowsByMetricId['metric-8'], false);
});

test('a fresh zero follower count settles a metric as not followed without reading subscriptions', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: 0, b: 0 }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  assert.deepEqual(calls, [], 'no discovery or targeted read is needed');
  for (const id of ['a', 'b']) {
    assert.equal(result.userFollowsByMetricId[id], false);
    assert.equal(result.groupFollowsByMetricId[id], false);
    assert.deepEqual(result.userFollowerIdsByMetricId[id], []);
    assert.equal(result.availabilityByMetricId[id]?.relationshipStatus, 'available');
    assert.equal(result.availabilityByMetricId[id]?.followerCountStatus, 'available');
    assert.equal(result.availabilityByMetricId[id]?.canLoadMore, false);
  }
  assert.deepEqual(result.errors, []);
  const personal = await getFollowState(session, 'user', [], ['a'], { detail: true, personalOnly: true }, dependencies);
  assert.equal(personal.userFollowsByMetricId.a, false);
  assert.equal(personal.groupFollowsByMetricId.a, undefined, 'personal-only scope still never reports group absence');
});

test('a zero count overrides retained coverage because it is newer evidence', async () => {
  const session = fixture(); let count: number | undefined; let reads = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async (_session, metricIds) => count === undefined ? isolated.followerCounts(_session, metricIds) : { countsByMetricId: { a: count }, errorsByMetricId: {} },
    listSubscriptionPage: async (_session, input) => { reads++; return { subscriptions: input.metricId ? [{ metricId: 'a', follower: { id: 'user', type: 'USER' } }] : [], nextPageToken: null }; },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(first.userFollowsByMetricId.a, true);
  count = 0;
  const after = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(after.userFollowsByMetricId.a, false);
  assert.equal(reads, 2);
});

test('a count equal to the followers already found settles a metric without a targeted read', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: 2, b: 2 }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => {
      calls.push(input.metricId ?? 'site');
      if (input.metricId) return { subscriptions: [{ metricId: input.metricId, follower: { id: 'user', type: 'USER' } }, { metricId: input.metricId, follower: { id: 'team', type: 'GROUP' } }], nextPageToken: null };
      return { subscriptions: [
        { metricId: 'a', follower: { id: 'user', type: 'USER' } }, { metricId: 'a', follower: { id: 'team', type: 'GROUP' } },
        { metricId: 'b', follower: { id: 'user', type: 'USER' } },
      ], nextPageToken: 'more' };
    },
  };
  const result = await getFollowState(session, 'user', [], ['a', 'b'], { detail: true, selectedGroupId: 'team' }, dependencies);
  assert.deepEqual(calls, ['site', 'b'], 'a is fully identified by discovery; b still has an unidentified follower');
  assert.equal(result.availabilityByMetricId.a?.relationshipStatus, 'available');
  assert.equal(result.groupFollowsByMetricId.a, true);
  assert.equal(result.availabilityByMetricId.b?.relationshipStatus, 'available');
});

test('unavailable counts fall back to targeted reads and keep the count diagnostic', async () => {
  const session = fixture(), calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => { throw new TableauError('Service unavailable.', 503); },
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const result = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(calls, ['site', 'a']);
  assert.equal(result.userFollowsByMetricId.a, false);
  assert.equal(result.availabilityByMetricId.a?.followerCountStatus, 'unavailable');
  assert.match(result.errors.join(' '), /Service unavailable/);
});

test('authentication from the count read stops detail before any subscription read', async () => {
  const auth = new TableauError('Authentication expired.', 401, '', 'auth'); let reads = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => { throw auth; },
    listSubscriptionPage: async () => { reads++; return { subscriptions: [], nextPageToken: null }; },
  };
  await assert.rejects(getFollowState(fixture(), 'user', [], ['a'], { detail: true }, dependencies), error => error === auth);
  assert.equal(reads, 0);
});

test('authentication stops new reads across concurrent workers', async () => {
  const auth = new TableauError('Authentication expired.', 401, '', 'auth'); const calls: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => {
      calls.push(input.metricId ?? 'site');
      await new Promise(resolve => setImmediate(resolve));
      if (input.metricId === 'metric-0') throw auth;
      return { subscriptions: [], nextPageToken: null };
    },
  };
  const ids = Array.from({ length: 40 }, (_, index) => `metric-${index}`);
  await assert.rejects(subscriptionCoverage(fixture(), ids, {}, dependencies), error => error === auth);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(calls.length - 1 <= SUBSCRIPTION_READ_CONCURRENCY * 2, `only reads already started may finish (${calls.length - 1})`);
});

test('invalid repeated continuation is terminal for its metric', async () => {
  const session = fixture(); let calls = 0;
  const dependencies: SubscriptionDependencies = { ...isolated,
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
    const dependencies: SubscriptionDependencies = { ...isolated,
      listSubscriptionPage: rejectedTarget === 'legacy' ? undefined : async (_session, input) => {
        const target = input.metricId ?? 'site'; calls.push(target);
        if (target === rejectedTarget) throw auth;
        return { subscriptions: [], nextPageToken: null };
      },
      listSubscriptions: async (_session, metricId) => { calls.push(metricId); throw auth; },
    };
    await assert.rejects(subscriptionCoverage(fixture(), ['a', 'b'], {}, dependencies), error => error === auth);
    // Reads already in flight may finish; no read starts after the rejection.
    assert.deepEqual(calls, rejectedTarget === 'site' ? ['site'] : rejectedTarget === 'a' ? ['site', 'a', 'b'] : ['a', 'b']);
  });
}

test('recoverable failed pages retain positive evidence and resume only on explicit demand', async () => {
  const session = fixture(); let calls = 0, recovering = false;
  const dependencies: SubscriptionDependencies = { ...isolated,
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
  const dependencies: SubscriptionDependencies = { ...isolated,
    listSubscriptionPage: async (_session, input) => { calls.push(input.metricId ?? 'site'); return { subscriptions: [], nextPageToken: null }; },
  };
  const firstIds = Array.from({ length: SUBSCRIPTION_CALLS_PER_REQUEST + 19 }, (_, index) => `first-${index}`);
  const first = await getFollowState(session, 'user', [], firstIds, { detail: true }, dependencies);
  assert.equal(calls.length, SUBSCRIPTION_CALLS_PER_REQUEST);
  assert.equal(Object.values(first.availabilityByMetricId).filter(value => value.canLoadMore).length, 20);
  assert.equal(first.coverage?.canLoadMore, true);
  const second = await getFollowState(session, 'user', [], ['last-1', 'last-2', 'last-3', 'last-4', 'last-5'], { detail: true }, dependencies);
  assert.equal(calls.length, SUBSCRIPTION_CALLS_PER_REQUEST + 5);
  assert.equal(second.coverage?.canLoadMore, false);
  assert.ok(Object.values(second.availabilityByMetricId).every(value => value.canLoadMore === false));
  const unresolvedIds = firstIds.filter(metricId => first.availabilityByMetricId[metricId]?.canLoadMore);
  const continued = await getFollowState(session, 'user', [], unresolvedIds, { detail: true, continueCoverage: true }, dependencies);
  assert.equal(calls.length, SUBSCRIPTION_CALLS_PER_REQUEST + 25);
  assert.ok(Object.values(continued.availabilityByMetricId).every(value => value.canLoadMore === false));
});

test('explicit refresh reacquires only the requested metrics after subscriptions change elsewhere', async () => {
  const session = fixture(), calls: string[] = [];
  let followers: Record<string, string[]> = { a: ['alice'], b: ['carol'] };
  const dependencies: SubscriptionDependencies = { ...isolated, siteNegativeCoverageQualified: true,
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
  const dependencies: SubscriptionDependencies = { ...isolated,
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

test('a count read while a mutation touches the metric cannot settle it afterwards', async () => {
  const session = fixture(); let release!: () => void, started!: () => void; const reads: string[] = [];
  const held = new Promise<void>(resolve => { release = resolve; });
  const counting = new Promise<void>(resolve => { started = resolve; });
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => { started(); await held; return { countsByMetricId: { a: 0 }, errorsByMetricId: {} }; },
    listSubscriptionPage: async (_session, input) => { reads.push(input.metricId ?? 'site'); return { subscriptions: input.metricId ? [{ metricId: 'a', follower: { id: 'user', type: 'USER' } }] : [], nextPageToken: null }; },
  };
  const pending = getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  await counting;
  invalidateSubscriptionCoverage(session, ['a']);
  release();
  const result = await pending;
  assert.deepEqual(reads, ['site', 'a'], 'the pre-mutation zero is ignored and the metric is read');
  assert.equal(result.userFollowsByMetricId.a, true);
});

test('a positive count after a zero reads followers again instead of keeping the zero as absence', async () => {
  const session = fixture(); let count = 0; const reads: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: count }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => { reads.push(input.metricId ?? 'site'); return { subscriptions: input.metricId ? [{ metricId: 'a', follower: { id: 'user', type: 'USER' } }] : [], nextPageToken: null }; },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(first.userFollowsByMetricId.a, false);
  assert.deepEqual(reads, []);
  count = 1;
  const after = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(reads, ['site', 'a'], 'the retained zero is stale, so the metric is read');
  assert.equal(after.userFollowsByMetricId.a, true);
  assert.equal(after.availabilityByMetricId.a?.relationshipStatus, 'available');
});

test('discovery a zero count disproves never settles a later positive count', async () => {
  const session = fixture(); let count = 1; const reads: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: count }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => {
      reads.push(input.metricId ?? 'site');
      // Discovery stays incomplete, so absence is never qualified by it; the targeted read sees the current follower.
      return input.metricId ? { subscriptions: [{ metricId: 'a', follower: { id: 'user', type: 'USER' } }], nextPageToken: null }
        : { subscriptions: [{ metricId: 'a', follower: { id: 'alice', type: 'USER' } }], nextPageToken: 'more' };
    },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(first.userFollowerIdsByMetricId?.a, ['alice'], 'discovery matching the count settles the metric');
  count = 0;
  const emptied = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(emptied.userFollowerIdsByMetricId?.a, []);
  count = 1;
  const after = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(reads, ['site', 'a'], 'the disproved discovery follower cannot match the new count, so the metric is read');
  assert.deepEqual(after.userFollowerIdsByMetricId?.a, ['user']);
  assert.equal(after.userFollowsByMetricId.a, true);
});

test('discovery naming more followers than a fresh count is not reported', async () => {
  const session = fixture(); const reads: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: 1 }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => {
      reads.push(input.metricId ?? 'site');
      if (input.metricId) throw new Error('Tableau could not list followers.');
      return { subscriptions: ['alice', 'bob'].map(id => ({ metricId: 'a', follower: { id, type: 'USER' as const } })), nextPageToken: 'more' };
    },
  };
  const result = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(reads, ['site', 'a']);
  assert.equal(result.userFollowerIdsByMetricId?.a, undefined, 'stale discovery followers are not offered as partial evidence');
  assert.equal(result.availabilityByMetricId.a?.relationshipStatus, 'unavailable');
});

test('qualified site absence that a fresh count contradicts is read again', async () => {
  const session = fixture(); let count: number | undefined; const reads: string[] = [];
  const dependencies: SubscriptionDependencies = { ...isolated, siteNegativeCoverageQualified: true,
    followerCounts: async (_session, metricIds) => count === undefined ? isolated.followerCounts(_session, metricIds) : { countsByMetricId: { a: count }, errorsByMetricId: {} },
    listSubscriptionPage: async (_session, input) => { reads.push(input.metricId ?? 'site'); return { subscriptions: input.metricId ? [{ metricId: 'a', follower: { id: 'user', type: 'USER' } }] : [], nextPageToken: null }; },
  };
  const first = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.equal(first.userFollowsByMetricId.a, false, 'complete qualified discovery establishes absence');
  count = 1;
  const after = await getFollowState(session, 'user', [], ['a'], { detail: true }, dependencies);
  assert.deepEqual(reads, ['site', 'a']);
  assert.equal(after.userFollowsByMetricId.a, true);
});

test('a mutation after a zero settles one metric, while another is still loading, never reports confirmed absence', async () => {
  const session = fixture(); let release!: () => void, reading!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { reading = resolve; });
  const dependencies: SubscriptionDependencies = { ...isolated,
    followerCounts: async () => ({ countsByMetricId: { a: 0 }, errorsByMetricId: {} }),
    listSubscriptionPage: async (_session, input) => {
      if (!input.metricId) { reading(); await held; }
      return { subscriptions: [], nextPageToken: null };
    },
  };
  const pending = getFollowState(session, 'user', [], ['a', 'b'], { detail: true }, dependencies);
  await started;
  invalidateSubscriptionCoverage(session, ['a']);
  release();
  const result = await pending;
  assert.equal(result.userFollowsByMetricId.a, undefined, 'the zero read before the mutation is not reported');
  assert.equal(result.groupFollowsByMetricId.a, undefined);
  assert.equal(result.availabilityByMetricId.a?.relationshipStatus, 'unavailable');
  assert.equal(result.availabilityByMetricId.a?.canLoadMore, true);
  assert.match(result.availabilityByMetricId.a?.diagnostics.map(d => d.message).join(' ') ?? '', /changed while loading/);
  assert.equal(result.availabilityByMetricId.b?.relationshipStatus, 'available', 'the untouched metric still completes');
});

test('a request for an unavailable inventory snapshot sends no count read', async () => {
  let counts = 0;
  const dependencies: SubscriptionDependencies = { ...isolated, followerCounts: async (session, ids) => { counts++; return isolated.followerCounts(session, ids); } };
  await assert.rejects(getFollowState(fixture(), 'user', [], ['a'], { detail: true, snapshotId: 'unknown-snapshot' }, dependencies), /no longer available/);
  assert.equal(counts, 0);
});
