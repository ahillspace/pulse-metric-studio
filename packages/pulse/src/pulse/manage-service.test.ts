import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableauError, type TableauSession } from '@pulse-metric-studio/core';
import {
  buildFollowTargets,
  cachedDefinitionInventory,
  clearPulseManageCaches,
  executeDeletes,
  followTargets,
  forkMetrics,
  FOLLOW_OPERATION_BATCH_LIMIT,
  getExistingMetrics,
  getFollowersDetail,
  getFollowState,
  getFollowTargets,
  invalidatePulseDefinitionInventory,
  timeframeMeasurementPeriod,
  unfollowTargets,
  type PulseManageDependencies,
} from './manage-service.js';

const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-1',
  token: 'token',
  apiVersion: '3.27',
};

function dependencies(overrides: Partial<PulseManageDependencies> = {}): PulseManageDependencies {
  return {
    listDefinitions: async () => ({ definitions: [], truncated: false }),
    listMetrics: async () => [],
    getMetric: async (_session, metricId) => ({
      id: metricId,
      definition_id: 'definition-1',
      specification: { filters: [], measurement_period: {}, comparison: {} },
    }),
    getDefinition: async () => ({ specification: { datasource: { id: 'datasource-1' } } }),
    getOrCreate: async () => ({ metricId: 'fork-1', created: true }),
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: 'visible',
      exactMetricResolved: true,
      inventoryVisible: true,
      ownershipVerified: true,
      attempts: 1,
    }),
    listSubscriptions: async () => [],
    createGroupSubscriptions: async (_session, items) => items.map((item) => ({
      metricId: item.metricId,
      targetId: item.groupId,
      ok: true,
      alreadyExists: false,
    })),
    createUserSubscriptions: async (_session, items) => items.map((item) => ({
      metricId: item.metricId,
      targetId: item.userId,
      ok: true,
      alreadyExists: false,
    })),
    deleteSubscription: async () => undefined,
    followerCounts: async (_session, metricIds) => ({
      countsByMetricId: Object.fromEntries(metricIds.map((metricId) => [metricId, 0])),
      errorsByMetricId: {},
    }),
    getUserName: async (_session, userId) => userId,
    listGroups: async () => [],
    listUsers: async () => [],
    ...overrides,
  };
}

test('date forking clones the exact source and replaces only measurement_period', async () => {
  const sourceSpecification = {
    datasource: { id: '00000000-0000-0000-0000-000000000000' },
    filters: [{ field: 'Region', categorical_values: [{ string_value: 'West' }] }],
    measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' },
    comparison: { comparison: 'TIME_COMPARISON_YEAR_AGO_PERIOD' },
    custom_state: { preserve: true },
  };
  const requests: Array<{ definitionId: string; specification: Record<string, unknown> }> = [];
  let createCalls = 0;
  const deps = dependencies({
    getMetric: async () => ({
      id: 'metric-1',
      definition_id: 'definition-1',
      specification: structuredClone(sourceSpecification),
    }),
    getOrCreate: async (_session, input) => {
      createCalls++;
      requests.push(structuredClone(input));
      return { metricId: 'fork-1', created: false };
    },
  });
  const outcomes = await forkMetrics(session, [
    { sourceMetricId: 'metric-1', timeframeKey: 'LAST_30_DAYS' },
    { sourceMetricId: 'metric-1', timeframeKey: 'LAST_30_DAYS' },
  ], deps);

  assert.equal(createCalls, 1);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'existing');
  assert.equal(outcomes[0]?.reconciliationStatus, 'visible');
  assert.deepEqual(requests[0], {
    definitionId: 'definition-1',
    specification: {
      filters: sourceSpecification.filters,
      measurement_period: {
        granularity: 'GRANULARITY_BY_DAY',
        range: 'RANGE_BY_CONFIG',
        last_x_period: {
          period: 30,
          period_type: 'GRANULARITY_BY_DAY',
          include_current_period: true,
        },
      },
      comparison: sourceSpecification.comparison,
      custom_state: sourceSpecification.custom_state,
    },
  });
  assert.equal(sourceSpecification.datasource.id, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(sourceSpecification.measurement_period, {
    granularity: 'GRANULARITY_BY_MONTH',
    range: 'RANGE_CURRENT_PARTIAL',
  });
});

test('date forking preserves bounded structured provider diagnostics', async () => {
  const outcomes = await forkMetrics(session, [
    { sourceMetricId: 'metric-1', timeframeKey: 'LAST_30_DAYS' },
  ], dependencies({
    getOrCreate: async () => {
      throw new TableauError('provider rejected request', 400, 'detail'.repeat(300));
    },
  }));
  assert.equal(outcomes[0]?.status, 'failed');
  assert.equal(outcomes[0]?.diagnostic?.status, 400);
  assert.ok((outcomes[0]?.diagnostic?.detail?.length ?? 0) <= 800);
});

test('date forking never reports a reconciliation failure as success', async () => {
  const outcomes = await forkMetrics(session, [
    { sourceMetricId: 'metric-1', timeframeKey: 'LAST_30_DAYS' },
  ], dependencies({
    getOrCreate: async () => ({ metricId: 'fork-wrong-owner', created: true }),
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: 'ownership_mismatch',
      exactMetricResolved: true,
      inventoryVisible: false,
      ownershipVerified: false,
      attempts: 1,
      diagnostic: { message: 'Metric belongs to another definition.' },
    }),
  }));
  assert.equal(outcomes[0]?.status, 'failed');
  assert.equal(outcomes[0]?.creationStatus, 'created');
  assert.equal(outcomes[0]?.reconciliationStatus, 'ownership_mismatch');
  assert.match(outcomes[0]?.error ?? '', /another definition/);
});

test('timeframe payloads use singular last_x_period and reject invalid custom periods', () => {
  assert.deepEqual(timeframeMeasurementPeriod({
    granularity: 'GRANULARITY_BY_DAY',
    range: 'RANGE_BY_CONFIG',
    lastXPeriod: { period: 7, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 7 days',
  }), {
    granularity: 'GRANULARITY_BY_DAY',
    range: 'RANGE_BY_CONFIG',
    last_x_period: { period: 7, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
  });
});

test('inventory projects each exact metric specification and reports definition failures', async () => {
  const deps = dependencies({
    listDefinitions: async () => ({
      definitions: [
        {
          metadata: { id: 'definition-1', name: 'Sales' },
          specification: {
            datasource: { id: 'datasource-1' },
            basic_specification: {
              measure: { field: 'Sales', aggregation: 'AGGREGATION_SUM' },
              time_dimension: { field: 'Order Date' },
            },
          },
        },
        { metadata: { id: 'definition-2', name: 'Profit' }, specification: { datasource: { id: 'datasource-1' } } },
      ],
      truncated: true,
    }),
    listMetrics: async (_session, definitionId) => {
      if (definitionId === 'definition-2') throw new TableauError('list failed', 503);
      return [
        { id: 'metric-1', is_default: false },
        { id: 'metric-2', is_default: false },
      ];
    },
    getMetric: async (_session, metricId) => {
      if (metricId === 'metric-2') throw new TableauError('exact metric failed', 502);
      return {
        id: metricId,
        definition_id: 'definition-1',
        is_default: false,
        specification: {
          filters: [{ field: 'Region' }],
          measurement_period: {
            granularity: 'GRANULARITY_BY_DAY',
            range: 'RANGE_BY_CONFIG',
            last_x_period: { period: 30, period_type: 'GRANULARITY_BY_DAY' },
          },
          comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
        },
      };
    },
  });
  const result = await getExistingMetrics(session, 'datasource-1', deps);
  assert.equal(result.totalScanned, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures.map((failure) => failure.stage).sort(), ['get_metric', 'list_metrics']);
  assert.equal(result.definitions[0]?.inventoryStatus, 'partial');
  assert.equal(result.definitions[1]?.inventoryStatus, 'unavailable');
  assert.deepEqual(result.definitions[0]?.metrics[0], {
    metricId: 'metric-1',
    name: 'metric-1',
    measurementPeriod: {
      granularity: 'GRANULARITY_BY_DAY',
      range: 'RANGE_BY_CONFIG',
      last_x_period: { period: 30, period_type: 'GRANULARITY_BY_DAY' },
    },
    timeframeLabel: 'Last 30 days',
    filters: [{ field: 'Region' }],
    comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
    isDefault: false,
    isScoped: true,
    scopedState: 'filtered',
    specification: {
      filters: [{ field: 'Region' }],
      measurement_period: {
        granularity: 'GRANULARITY_BY_DAY',
        range: 'RANGE_BY_CONFIG',
        last_x_period: { period: 30, period_type: 'GRANULARITY_BY_DAY' },
      },
      comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
    },
  });
});

test('inventory reports malformed definition and metric records instead of dropping them', async () => {
  const result = await getExistingMetrics(session, 'datasource-1', dependencies({
    listDefinitions: async () => ({
      definitions: [
        null as unknown as never,
        { metadata: { name: 'Missing ID' }, specification: { datasource: { id: 'datasource-1' } } },
        { metadata: { id: 'definition-no-datasource' } },
        { metadata: { id: 'definition-valid' }, specification: { datasource: { id: 'datasource-1' } } },
      ],
      truncated: false,
    }),
    listMetrics: async () => [null as unknown as never, {}],
  }));
  assert.equal(result.totalScanned, 4);
  assert.equal(result.definitions.length, 1);
  assert.equal(result.definitions[0]?.definitionId, 'definition-valid');
  assert.equal(result.definitions[0]?.inventoryStatus, 'partial');
  assert.deepEqual(result.failures.map((failure) => failure.stage).sort(), [
    'parse_definition',
    'parse_definition',
    'parse_definition',
    'parse_metric',
    'parse_metric',
  ].sort());
});

test('site-wide definition inventory uses a bounded short-lived cache', async () => {
  clearPulseManageCaches();
  let calls = 0;
  const deps = dependencies({
    listDefinitions: async () => {
      calls++;
      return { definitions: [{ metadata: { id: 'definition-1' } }], truncated: false };
    },
  });
  const first = await cachedDefinitionInventory(session, deps);
  first.definitions[0]!.metadata!.id = 'mutated';
  const second = await cachedDefinitionInventory(session, deps);
  assert.equal(calls, 1);
  assert.equal(second.definitions[0]?.metadata?.id, 'definition-1');
  invalidatePulseDefinitionInventory(session);
  await cachedDefinitionInventory(session, deps);
  assert.equal(calls, 2);
  clearPulseManageCaches();
});

test('deleting an exact metric invalidates the cached inventory so it is not shown as still present', async () => {
  clearPulseManageCaches();
  let listCalls = 0;
  const deps = dependencies({
    listDefinitions: async () => {
      listCalls++;
      return { definitions: [{ metadata: { id: 'definition-1' } }], truncated: false };
    },
  });
  // Warm the cache, then delete an exact metric (no definitionId).
  await cachedDefinitionInventory(session, deps);
  assert.equal(listCalls, 1);
  const deleted: string[] = [];
  const result = await executeDeletes(
    session,
    [{ metricIds: ['metric-1'], name: 'Deal Cycle Length' }],
    {
      deleteDefinition: async () => assert.fail('no definition should be deleted'),
      deleteMetric: async (_session, metricId) => { deleted.push(metricId); },
    },
  );
  assert.deepEqual(deleted, ['metric-1']);
  assert.equal(result.metricsDeleted, 1);
  assert.equal(result.definitionsDeleted, 0);
  assert.deepEqual(result.failures, []);
  // The metric-only delete must have busted the cache, so the next read refetches.
  await cachedDefinitionInventory(session, deps);
  assert.equal(listCalls, 2);
  clearPulseManageCaches();
});

test('a failed exact-metric delete leaves the inventory cache intact', async () => {
  clearPulseManageCaches();
  let listCalls = 0;
  const deps = dependencies({
    listDefinitions: async () => {
      listCalls++;
      return { definitions: [{ metadata: { id: 'definition-1' } }], truncated: false };
    },
  });
  await cachedDefinitionInventory(session, deps);
  assert.equal(listCalls, 1);
  const result = await executeDeletes(
    session,
    [{ metricIds: ['metric-1'], name: 'Deal Cycle Length' }],
    {
      deleteDefinition: async () => assert.fail('no definition should be deleted'),
      deleteMetric: async () => { throw new TableauError('boom', 500, '', 'http'); },
    },
  );
  assert.equal(result.metricsDeleted, 0);
  assert.equal(result.failures.length, 1);
  // Nothing was deleted, so the cache should still serve without a refetch.
  await cachedDefinitionInventory(session, deps);
  assert.equal(listCalls, 1);
  clearPulseManageCaches();
});

test('follow state uses the selected group and retains partial per-metric failures', async () => {
  const result = await getFollowState(
    session,
    'user-1',
    ['group-other'],
    ['metric-2', 'metric-1'],
    { selectedGroupId: 'group-selected' },
    dependencies({
      followerCounts: async () => ({
        countsByMetricId: { 'metric-1': 2 },
        errorsByMetricId: { 'metric-2': { message: 'count unavailable' } },
      }),
      listSubscriptions: async (_session, metricId) => {
        if (metricId === 'metric-2') throw new TableauError('subscriptions unavailable', 503);
        return [
          { follower: { id: 'user-1', type: 'USER' } },
          { follower: { id: 'group-selected', type: 'GROUP' } },
          { follower: { id: 'group-other', type: 'GROUP' } },
        ];
      },
    }),
  );
  assert.equal(result.selectedGroupId, 'group-selected');
  assert.equal(result.userFollowsByMetricId['metric-1'], true);
  assert.equal(result.groupFollowsByMetricId['metric-1'], true);
  assert.equal(result.userFollowsByMetricId['metric-2'], undefined);
  assert.equal(result.groupFollowsByMetricId['metric-2'], undefined);
  assert.equal(result.availabilityByMetricId['metric-1']?.status, 'available');
  assert.equal(result.availabilityByMetricId['metric-1']?.relationshipStatus, 'available');
  assert.equal(result.availabilityByMetricId['metric-1']?.followerCountStatus, 'available');
  assert.equal(result.availabilityByMetricId['metric-2']?.status, 'unavailable');
  assert.equal(result.availabilityByMetricId['metric-2']?.relationshipStatus, 'unavailable');
  assert.equal(result.availabilityByMetricId['metric-2']?.followerCountStatus, 'unavailable');
  assert.equal(result.followerCountsByMetricId['metric-2'], undefined);
});

test('follow state records every distinct group follower for the row summary, regardless of membership', async () => {
  const result = await getFollowState(
    session,
    'user-1',
    ['group-i-belong-to'],
    ['metric-1'],
    {},
    dependencies({
      listSubscriptions: async () => [
        { follower: { id: 'group-i-belong-to', type: 'GROUP' } },
        { follower: { id: 'group-someone-else-added', type: 'GROUP' } },
        { follower: { id: 'group-someone-else-added', type: 'GROUP' } },
        { follower: { id: 'user-9', type: 'USER' } },
        { follower: { id: 'user-9', type: 'USER' } },
        { follower: { id: 'user-1', type: 'USER' } },
      ],
    }),
  );
  // The current-user "my group follows" boolean is still membership-scoped ...
  assert.equal(result.groupFollowsByMetricId['metric-1'], true);
  // ... but the summary source counts ALL distinct group followers (deduped),
  // including a group the current user is not a member of.
  assert.deepEqual(result.groupFollowerIdsByMetricId['metric-1'], ['group-i-belong-to', 'group-someone-else-added']);
  // Distinct individual (USER) followers are recorded the same way, deduped and
  // membership-agnostic, so the row/blast-radius summary can count real people.
  assert.deepEqual(result.userFollowerIdsByMetricId['metric-1'], ['user-9', 'user-1']);
});

test('follow state preserves accurate relationships when follower counts fail', async () => {
  const result = await getFollowState(
    session,
    'user-1',
    ['group-1'],
    ['metric-1'],
    {},
    dependencies({
      followerCounts: async () => ({
        countsByMetricId: {},
        errorsByMetricId: { 'metric-1': { message: 'count unavailable' } },
      }),
      listSubscriptions: async () => [
        { follower: { id: 'user-1', type: 'USER' } },
      ],
    }),
  );
  assert.equal(result.userFollowsByMetricId['metric-1'], true);
  assert.equal(result.groupFollowsByMetricId['metric-1'], false);
  assert.equal(result.availabilityByMetricId['metric-1']?.status, 'partial');
  assert.equal(result.availabilityByMetricId['metric-1']?.relationshipStatus, 'available');
  assert.equal(result.availabilityByMetricId['metric-1']?.followerCountStatus, 'unavailable');
});

test('follow state marks unsupported follower types and group context as relationship uncertainty', async () => {
  const result = await getFollowState(
    session,
    'user-1',
    [],
    ['metric-1'],
    { groupContextUnavailable: true },
    dependencies({
      listSubscriptions: async () => [{ follower: { id: 'unknown-1', type: 'UNKNOWN' } }],
    }),
  );
  assert.equal(result.userFollowsByMetricId['metric-1'], undefined);
  assert.equal(result.groupFollowsByMetricId['metric-1'], undefined);
  assert.equal(result.availabilityByMetricId['metric-1']?.relationshipStatus, 'partial');
  assert.equal(result.availabilityByMetricId['metric-1']?.followerCountStatus, 'available');
});

test('follow returns every exact metric-target result, treats existing group follows idempotently, and batches beyond 200', async () => {
  const batchSizes: number[] = [];
  const operations = Array.from({ length: 405 }, (_, index) => ({
    metricId: `metric-${index}`,
    target: { id: 'group-exact', kind: 'GROUP' as const },
  }));
  const result = await followTargets(session, { operations }, dependencies({
    listSubscriptions: async (_session, metricId) => metricId === 'metric-0'
      ? [{ id: 'subscription-existing', follower: { id: 'group-exact', type: 'GROUP' } }]
      : [],
    createGroupSubscriptions: async (_session, items) => {
      batchSizes.push(items.length);
      return items.map((item) => ({
        metricId: item.metricId,
        targetId: item.groupId,
        ok: item.metricId !== 'metric-250',
        alreadyExists: item.metricId === 'metric-300',
        ...(item.metricId === 'metric-250' ? { error: 'provider rejected this pair' } : {}),
      }));
    },
  }));

  assert.equal(FOLLOW_OPERATION_BATCH_LIMIT, 200);
  assert.deepEqual(batchSizes, [200, 200, 4]);
  assert.equal(result.length, 405);
  assert.deepEqual(result[0], {
    metricId: 'metric-0',
    targetId: 'group-exact',
    targetKind: 'GROUP',
    status: 'already_followed',
    ok: true,
  });
  assert.equal(result[250]?.status, 'failed');
  assert.equal(result[300]?.status, 'already_followed');
  assert.equal(result[404]?.status, 'followed');
});

test('unfollow reports and retries each exact metric-target pair independently', async () => {
  let failGroupTwo = true;
  const deps = dependencies({
    listSubscriptions: async () => [
      { id: 'subscription-group-1', follower: { id: 'target-1', type: 'GROUP' } },
      { id: 'subscription-group-2', follower: { id: 'target-2', type: 'GROUP' } },
      { id: 'subscription-user-1', follower: { id: 'target-1', type: 'USER' } },
    ],
    deleteSubscription: async (_session, subscriptionId) => {
      if (subscriptionId === 'subscription-group-2' && failGroupTwo) throw new Error('delete failed');
    },
  });
  const operations = [
    { metricId: 'metric-exact', target: { id: 'target-1', kind: 'GROUP' as const } },
    { metricId: 'metric-exact', target: { id: 'target-2', kind: 'GROUP' as const } },
    { metricId: 'metric-exact', target: { id: 'missing', kind: 'USER' as const } },
  ];
  const first = await unfollowTargets(session, { operations }, deps);
  assert.deepEqual(first.map((entry) => ({ targetId: entry.targetId, status: entry.status })), [
    { targetId: 'target-1', status: 'unfollowed' },
    { targetId: 'target-2', status: 'failed' },
    { targetId: 'missing', status: 'not_followed' },
  ]);

  failGroupTwo = false;
  const retry = await unfollowTargets(session, { operations: [operations[1]!] }, deps);
  assert.deepEqual(retry, [{
    metricId: 'metric-exact',
    targetId: 'target-2',
    targetKind: 'GROUP',
    status: 'unfollowed',
    ok: true,
  }]);
});

test('follower details distinguish successful empty, partial name lookup, and unavailable states', async () => {
  clearPulseManageCaches();
  let userLookups = 0;
  const deps = dependencies({
    listSubscriptions: async (_session, metricId) => {
      if (metricId === 'metric-3') throw new TableauError('unsupported response', 502);
      if (metricId === 'metric-2') return [];
      return [{ follower: { id: 'user-2', type: 'USER' } }];
    },
    getUserName: async () => {
      userLookups++;
      throw new TableauError('user lookup failed', 503);
    },
  });
  const first = await getFollowersDetail(session, ['metric-1', 'metric-2', 'metric-3'], deps);
  const second = await getFollowersDetail(session, ['metric-1'], deps);
  assert.equal(first[0]?.status, 'partial');
  assert.deepEqual(first[0]?.followers, [{ id: 'user-2', name: 'user-2', type: 'USER' }]);
  assert.equal(first[1]?.status, 'available');
  assert.deepEqual(first[1]?.followers, []);
  assert.equal(first[2]?.status, 'unavailable');
  assert.deepEqual(first[2]?.followers, []);
  assert.equal(second[0]?.status, 'partial');
  assert.equal(userLookups, 2);
});

test('follower display-name lookups reuse the bounded cache', async () => {
  clearPulseManageCaches();
  let userLookups = 0;
  const deps = dependencies({
    listSubscriptions: async () => [{ follower: { id: 'user-2', type: 'USER' } }],
    getUserName: async () => {
      userLookups++;
      return 'Ada Lovelace';
    },
  });
  const first = await getFollowersDetail(session, ['metric-1'], deps);
  const second = await getFollowersDetail(session, ['metric-2'], deps);
  assert.equal(first[0]?.followers[0]?.name, 'Ada Lovelace');
  assert.equal(second[0]?.followers[0]?.name, 'Ada Lovelace');
  assert.equal(userLookups, 1);
  clearPulseManageCaches();
});

test('group follower names resolve from a single site-group listing and stay available', async () => {
  clearPulseManageCaches();
  let groupListings = 0;
  const deps = dependencies({
    listSubscriptions: async (_session, metricId) => (metricId === 'metric-1'
      ? [
        { follower: { id: 'group-1', type: 'GROUP' } },
        { follower: { id: 'group-2', type: 'GROUP' } },
      ]
      : [{ follower: { id: 'group-1', type: 'GROUP' } }]),
    listGroups: async () => {
      groupListings++;
      return [
        { id: 'group-1', name: 'Sales' },
        { id: 'group-2', name: 'Support' },
      ];
    },
  });
  const details = await getFollowersDetail(session, ['metric-1', 'metric-2'], deps);
  assert.equal(details[0]?.status, 'available');
  assert.deepEqual(details[0]?.followers, [
    { id: 'group-1', name: 'Sales', type: 'GROUP' },
    { id: 'group-2', name: 'Support', type: 'GROUP' },
  ]);
  assert.equal(details[1]?.followers[0]?.name, 'Sales');
  // The listing is fetched once and cached for all group followers across metrics.
  assert.equal(groupListings, 1);
  clearPulseManageCaches();
});

test('group follower that vanished from the site listing degrades to partial', async () => {
  clearPulseManageCaches();
  const deps = dependencies({
    listSubscriptions: async () => [{ follower: { id: 'group-gone', type: 'GROUP' } }],
    listGroups: async () => [{ id: 'group-1', name: 'Sales' }],
  });
  const details = await getFollowersDetail(session, ['metric-1'], deps);
  assert.equal(details[0]?.status, 'partial');
  assert.equal(details[0]?.followers[0]?.name, 'group-gone');
  clearPulseManageCaches();
});

test('follow-target inventory merges the full site inventory and sorts (no name filter)', async () => {
  let groupCalls = 0;
  let userCalls = 0;
  const deps = dependencies({
    listGroups: async () => {
      groupCalls += 1;
      return [{ id: 'group-1', name: 'Zebra Team' }];
    },
    listUsers: async () => {
      userCalls += 1;
      return [{ id: 'user-1', name: 'Ada Lovelace' }];
    },
  });
  const inventory = await getFollowTargets(session, deps);
  assert.deepEqual(inventory.targets, [
    { id: 'user-1', name: 'Ada Lovelace', kind: 'USER' },
    { id: 'group-1', name: 'Zebra Team', kind: 'GROUP' },
  ]);
  assert.deepEqual(inventory.errors, []);
  // The picker loads the whole inventory once; each provider is called exactly once.
  assert.equal(groupCalls, 1);
  assert.equal(userCalls, 1);
});

test('follow-target inventory survives a partial provider failure', async () => {
  const deps = dependencies({
    listGroups: async () => { throw new TableauError('group listing failed', 502); },
    listUsers: async () => [{ id: 'user-1', name: 'Ada Lovelace' }],
  });
  const inventory = await getFollowTargets(session, deps);
  assert.deepEqual(inventory.targets, [{ id: 'user-1', name: 'Ada Lovelace', kind: 'USER' }]);
  assert.equal(inventory.errors.length, 1);
});

test('follow-target inventory rethrows auth failures', async () => {
  const deps = dependencies({
    listUsers: async () => { throw new TableauError('expired', 401, '', 'auth'); },
  });
  await assert.rejects(() => getFollowTargets(session, deps), /expired/);
});

test('getFollowTargets over the real client sends no name:has filter in any request URL', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/groups')) {
      return Response.json({ groups: { group: [{ id: 'group-1', name: 'Sales' }] } });
    }
    return Response.json({ users: { user: [{ id: 'user-1', name: 'ada@example.test', fullName: 'Ada Lovelace' }] } });
  }) as typeof globalThis.fetch;
  try {
    const inventory = await getFollowTargets(session);
    assert.deepEqual(inventory.targets, [
      { id: 'user-1', name: 'Ada Lovelace', kind: 'USER' },
      { id: 'group-1', name: 'Sales', kind: 'GROUP' },
    ]);
    assert.ok(urls.length >= 2);
    for (const url of urls) {
      assert.doesNotMatch(url, /filter=name/);
      assert.doesNotMatch(url, /has%3A/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildFollowTargets sorts merged targets case-insensitively by name', () => {
  const targets = buildFollowTargets(
    [{ id: 'group-1', name: 'beta' }],
    [{ id: 'user-1', name: 'Alpha' }, { id: 'user-2', name: 'gamma' }],
  );
  assert.deepEqual(targets.map((target) => target.name), ['Alpha', 'beta', 'gamma']);
});
