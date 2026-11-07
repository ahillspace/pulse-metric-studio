import { TableauError, type TableauSession } from '@pulse-metric-studio/core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach,test } from 'node:test';
import {
batchCreateGroupSubscriptions,
batchCreateUserSubscriptions,
batchGetFollowerCounts,
FOLLOWER_COUNT_BATCH_LIMIT,
FOLLOWER_COUNT_SPLIT_SENDS_PER_BATCH,
forkMetricToTimeframe,
getOrCreateDimensionalMetric,
getPulseDefinition,
getPulseMetric,
listDefinitionsInventory,
listSubscriptionsForMetric,
normalizeFollowerCountEnvelope,
normalizeSubscriptionEnvelope,
queryPulseDimensionDistinctCount,
queryPulseDimensionValues,
} from './pulse-client.js';

const originalFetch = globalThis.fetch;
const providerContracts = JSON.parse(readFileSync(new URL(
  './fixtures/tableau-cloud/3.27/2026-08-29/pulse-provider-contracts.sanitized.json',
  import.meta.url,
), 'utf8')) as {
  contracts: {
    definition: { response: unknown };
    exactMetrics: { responses: { default: unknown } };
    getOrCreate: { request: unknown; successResponse: unknown };
    subscriptions: { response: unknown };
    followerCounts: { response: unknown };
    vdsDistinctValues: { response: { data: Array<[string | null]> } };
  };
};
const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('exact Pulse resource clients use metric and definition identifiers', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json(urls.length === 1
      ? providerContracts.contracts.exactMetrics.responses.default
      : providerContracts.contracts.definition.response);
  };
  assert.equal((await getPulseMetric(session, 'm/1')).id, 'metric-default-001');
  assert.equal((await getPulseDefinition(session, 'd/1')).metadata?.id, 'definition-captured-001');
  assert.deepEqual(urls, [
    'https://example.test/api/-/pulse/metrics/m%2F1',
    'https://example.test/api/-/pulse/definitions/d%2F1',
  ]);
});

test('definition inventory reports its pagination cap instead of silently truncating', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      definitions: [{ metadata: { id: `definition-${calls}` } }],
      next_page_token: `token-${calls}`,
    });
  };
  const result = await listDefinitionsInventory(session, 2);
  assert.equal(calls, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.definitions.map((definition) => definition.metadata?.id), ['definition-1', 'definition-2']);
});

test('definition inventory rejects unsupported response shapes', async () => {
  globalThis.fetch = async () => Response.json({ items: [] });
  await assert.rejects(() => listDefinitionsInventory(session, 1), /requires a definitions array/);
});

test('dimensional get-or-create pins the documented envelope without fallback payloads', async () => {
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json(providerContracts.contracts.getOrCreate.successResponse);
  };
  const capturedRequest = providerContracts.contracts.getOrCreate.request as {
    definition_id: string;
    specification: Record<string, unknown>;
  };
  const result = await getOrCreateDimensionalMetric(session, {
    definitionId: capturedRequest.definition_id,
    specification: capturedRequest.specification,
  });
  assert.deepEqual(requestBody, capturedRequest);
  assert.deepEqual({ metricId: result.metricId, metricApiName: result.metricApiName, created: result.created }, {
    metricId: 'metric-timeframe-001',
    metricApiName: 'captured_metric_timeframe_001',
    created: true,
  });
});

test('dimensional get-or-create rejects a missing or non-Boolean creation flag', async () => {
  globalThis.fetch = async () => Response.json({ metric: { metadata: { id: 'fork-1' } } });
  await assert.rejects(() => getOrCreateDimensionalMetric(session, {
    definitionId: 'definition-1',
    specification: { filters: [] },
  }), /Boolean is_metric_created/);

  globalThis.fetch = async () => Response.json({
    metric: { metadata: { id: 'fork-1' } },
    is_metric_created: 'false',
  });
  await assert.rejects(() => getOrCreateDimensionalMetric(session, {
    definitionId: 'definition-1',
    specification: { filters: [] },
  }), /Boolean is_metric_created/);
});

test('timeframe get-or-create also rejects a missing creation flag', async () => {
  globalThis.fetch = async () => Response.json({ metric: { metadata: { id: 'fork-1' } } });
  await assert.rejects(() => forkMetricToTimeframe(session, {
    definitionId: 'definition-1',
    specification: { measurement_period: { granularity: 'GRANULARITY_MONTH' } },
  }), /Boolean is_metric_created/);
});

test('subscription normalization supports pinned direct and nested envelopes', () => {
  assert.deepEqual(normalizeSubscriptionEnvelope(providerContracts.contracts.subscriptions.response), [
    { id: 'subscription-user-001', follower: { id: 'user-captured-001', type: 'USER', name: 'Captured User' } },
    { id: 'subscription-group-001', follower: { id: 'group-captured-001', type: 'GROUP', name: 'Captured Group' } },
  ]);
  assert.deepEqual(normalizeSubscriptionEnvelope({ subscription: [] }), []);
  assert.deepEqual(normalizeSubscriptionEnvelope([]), []);
});

test('subscription normalization rejects unsupported containers instead of reporting no followers', () => {
  assert.throws(() => normalizeSubscriptionEnvelope({ subscriptions: { items: [] } }), /Unsupported Pulse subscriptions response shape/);
  assert.throws(() => normalizeSubscriptionEnvelope({}), /Unsupported Pulse subscription response shape/);
  assert.throws(() => normalizeSubscriptionEnvelope({ subscriptions: [{}] }), /Unsupported Pulse subscription follower/);
});

test('group subscription creation classifies an existing subscription as an idempotent success', async () => {
  globalThis.fetch = async () => Response.json(
    { error: 'Subscription already exists for this follower' },
    { status: 409 },
  );
  const result = await batchCreateGroupSubscriptions(session, [{ metricId: 'metric-exact', groupId: 'group-exact' }]);
  assert.deepEqual(result, [{
    metricId: 'metric-exact',
    targetId: 'group-exact',
    ok: true,
    alreadyExists: true,
  }]);
});

test('user subscription creation uses the same batchCreate endpoint and media type as groups', async () => {
  let url = '';
  let contentType: string | null = null;
  let requestBody: unknown;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    contentType = headers.get('content-type');
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ subscriptions: [{ follower: { user_id: 'user-exact' } }] });
  };
  const result = await batchCreateUserSubscriptions(session, [{ metricId: 'metric-exact', userId: 'user-exact' }]);
  assert.equal(url, 'https://example.test/api/-/pulse/subscriptions:batchCreate');
  assert.equal(contentType, 'application/vnd.tableau.pulse.subscriptionservice.v1.BatchCreateSubscriptionsRequest+json');
  assert.deepEqual(requestBody, { metric_id: 'metric-exact', followers: [{ user_id: 'user-exact' }] });
  assert.deepEqual(result, [{
    metricId: 'metric-exact',
    targetId: 'user-exact',
    ok: true,
    alreadyExists: false,
  }]);
});

test('user subscription creation classifies an existing subscription as an idempotent success', async () => {
  globalThis.fetch = async () => Response.json(
    { error: 'Subscription already exists for this follower' },
    { status: 409 },
  );
  const result = await batchCreateUserSubscriptions(session, [{ metricId: 'metric-exact', userId: 'user-exact' }]);
  assert.deepEqual(result, [{
    metricId: 'metric-exact',
    targetId: 'user-exact',
    ok: true,
    alreadyExists: true,
  }]);
});

test('group subscription creation reports unrelated conflicts as failures', async () => {
  globalThis.fetch = async () => Response.json(
    { error: 'Metric configuration conflict' },
    { status: 409 },
  );
  const result = await batchCreateGroupSubscriptions(session, [{ metricId: 'metric-exact', groupId: 'group-exact' }]);
  assert.equal(result[0]?.ok, false);
  assert.equal(result[0]?.alreadyExists, false);
});

test('follower-count normalization supports both provider record aliases', () => {
  assert.deepEqual(normalizeFollowerCountEnvelope({
    follower_counts: [
      { metric_id: 'm1', follower_count: 0 },
      { metric_id: 'm2', follower_count: 4 },
    ],
  }), { m1: 0, m2: 4 });
  assert.deepEqual(normalizeFollowerCountEnvelope(providerContracts.contracts.followerCounts.response), {
    'metric-default-001': 2,
    'metric-timeframe-001': 0,
  });
  assert.throws(() => normalizeFollowerCountEnvelope({}), /Unsupported Pulse follower-count response shape/);
});

test('follower counts batch every metric ID beyond the local URL bound', async () => {
  const requestBatches: string[][] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.body, undefined);
    const metricIds = new URL(String(input)).searchParams.get('metric_ids')!.split(',');
    requestBatches.push(metricIds);
    return Response.json({
      follower_counts: metricIds.map((metricId) => ({ metric_id: metricId, follower_count: 1 })),
    });
  };
  const metricIds = Array.from({ length: 405 }, (_, index) => `metric-${index}`);
  const result = await batchGetFollowerCounts(session, metricIds);
  assert.equal(FOLLOWER_COUNT_BATCH_LIMIT, 100);
  assert.deepEqual(requestBatches.map((batch) => batch.length), [100, 100, 100, 100, 5]);
  assert.equal(Object.keys(result.countsByMetricId).length, 405);
  assert.deepEqual(result.errorsByMetricId, {});
});

function rejectingFollowerCounts(rejected: Set<string>, sends: string[][]) {
  globalThis.fetch = async (input) => {
    const metricIds = new URL(String(input)).searchParams.get('metric_ids')!.split(',');
    sends.push(metricIds);
    if (metricIds.some((metricId) => rejected.has(metricId))) {
      return Response.json({ error: { code: 'invalid_metric_id', message: 'Invalid metric' } }, { status: 400 });
    }
    return Response.json({ follower_counts: metricIds.map((metricId) => ({ metric_id: metricId, follower_count: 2 })) });
  };
}

test('a rejected follower-count batch is split so only the rejected metric lacks a count', async () => {
  const sends: string[][] = [];
  rejectingFollowerCounts(new Set(['metric-37']), sends);
  const metricIds = Array.from({ length: 100 }, (_, index) => `metric-${index}`);
  const result = await batchGetFollowerCounts(session, metricIds);
  assert.deepEqual(Object.keys(result.errorsByMetricId), ['metric-37']);
  assert.equal(result.errorsByMetricId['metric-37']?.status, 400);
  assert.equal(Object.keys(result.countsByMetricId).length, 99);
  assert.equal(result.countsByMetricId['metric-36'], 2);
  assert.ok(sends.length <= 1 + FOLLOWER_COUNT_SPLIT_SENDS_PER_BATCH, `split sends stay bounded, got ${sends.length}`);
  assert.ok(sends.every((batch) => batch.length <= FOLLOWER_COUNT_BATCH_LIMIT));
});

test('follower-count splitting stops at its send budget and marks only unresolved metrics', async () => {
  const sends: string[][] = [];
  const metricIds = Array.from({ length: 100 }, (_, index) => `metric-${index}`);
  const rejected = ['metric-0', 'metric-30', 'metric-60', 'metric-90'];
  rejectingFollowerCounts(new Set(rejected), sends);
  const result = await batchGetFollowerCounts(session, metricIds);
  assert.equal(sends.length, 1 + FOLLOWER_COUNT_SPLIT_SENDS_PER_BATCH);
  for (const metricId of metricIds) {
    assert.ok(Object.hasOwn(result.countsByMetricId, metricId) !== Object.hasOwn(result.errorsByMetricId, metricId), metricId);
  }
  for (const metricId of rejected) assert.ok(result.errorsByMetricId[metricId], `${metricId} stays without a count`);
  assert.ok(Object.keys(result.countsByMetricId).length >= 45, 'accepted halves keep their counts when the budget runs out');
  assert.ok(Object.keys(result.errorsByMetricId).length < 60, 'only the still-rejected groups lack counts');
});

test('follower-count failures other than a rejected multi-metric batch are not split', async () => {
  for (const status of [403, 404, 500]) {
    let sends = 0;
    globalThis.fetch = async () => { sends++; return Response.json({ error: 'no' }, { status }); };
    const result = await batchGetFollowerCounts(session, ['metric-a', 'metric-b']);
    assert.equal(sends, 1, `status ${status} is reported for the batch without extra sends`);
    assert.deepEqual(Object.keys(result.errorsByMetricId).sort(), ['metric-a', 'metric-b']);
  }
  let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ error: 'no' }, { status: 400 }); };
  const single = await batchGetFollowerCounts(session, ['metric-only']);
  assert.equal(sends, 1, 'a single rejected metric is final');
  assert.equal(single.errorsByMetricId['metric-only']?.status, 400);
});

test('follower-count authentication failures still stop the read', async () => {
  globalThis.fetch = async () => Response.json({ error: 'expired' }, { status: 401 });
  await assert.rejects(batchGetFollowerCounts(session, ['metric-a', 'metric-b']), (error: unknown) => error instanceof TableauError && error.kind === 'auth');
});

test('VDS distinct query uses a bounded grouped one-dimension query by raw field name', async () => {
  let url = '';
  let requestBody: any;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Response.json(providerContracts.contracts.vdsDistinctValues.response);
  };
  const rows = await queryPulseDimensionValues(session, {
    datasourceLuid: 'datasource-1',
    fieldName: 'Region',
    rowLimit: 1_000,
  });
  assert.equal(url, 'https://example.test/api/v1/vizql-data-service/query-datasource');
  assert.deepEqual(rows, [['Captured Central'], ['Captured West'], [null]]);
  assert.deepEqual(requestBody, {
    datasource: { datasourceLuid: 'datasource-1' },
    query: { fields: [{ fieldCaption: 'Region', sortPriority: 1, sortDirection: 'ASC' }] },
    options: {
      disaggregate: false,
      interpretFieldCaptionsAsFieldNames: true,
      returnFormat: 'ARRAYS',
      rowLimit: 1_000,
      returnServerSentEvents: false,
    },
  });
});

test('VDS distinct query adds a bounded contains filter for server-side substring search', async () => {
  let requestBody: any;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ data: [['Captured West']] });
  };
  const rows = await queryPulseDimensionValues(session, {
    datasourceLuid: 'datasource-1',
    fieldName: 'Region',
    rowLimit: 200,
    contains: 'wes',
  });
  assert.deepEqual(rows, [['Captured West']]);
  assert.deepEqual(requestBody.query, {
    fields: [{ fieldCaption: 'Region', sortPriority: 1, sortDirection: 'ASC' }],
    filters: [{ field: { fieldCaption: 'Region' }, filterType: 'MATCH', contains: 'wes', exclude: false }],
  });
  assert.equal(requestBody.options.rowLimit, 200);
});

test('VDS distinct query adds a set filter to validate an explicit value list', async () => {
  let requestBody: any;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ data: [['West'], ['Central']] });
  };
  const rows = await queryPulseDimensionValues(session, {
    datasourceLuid: 'datasource-1',
    fieldName: 'Region',
    rowLimit: 2,
    matchValues: ['West', 'Central'],
  });
  assert.deepEqual(rows, [['West'], ['Central']]);
  assert.deepEqual(requestBody.query.filters, [{
    field: { fieldCaption: 'Region' },
    filterType: 'SET',
    values: ['West', 'Central'],
    exclude: false,
  }]);
});

test('VDS distinct-count query aggregates COUNTD by raw field name', async () => {
  let url = '';
  let requestBody: any;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ data: [[4200]] });
  };
  const count = await queryPulseDimensionDistinctCount(session, {
    datasourceLuid: 'datasource-1',
    fieldName: 'Region',
  });
  assert.equal(url, 'https://example.test/api/v1/vizql-data-service/query-datasource');
  assert.equal(count, 4200);
  assert.deepEqual(requestBody, {
    datasource: { datasourceLuid: 'datasource-1' },
    query: { fields: [{ fieldCaption: 'Region', function: 'COUNTD' }] },
    options: {
      disaggregate: false,
      interpretFieldCaptionsAsFieldNames: true,
      returnFormat: 'ARRAYS',
      returnServerSentEvents: false,
    },
  });
});

test('VDS distinct-count query rejects provider errors and non-numeric shapes', async () => {
  globalThis.fetch = async () => Response.json({ data: [[10]], error: { message: 'stream interrupted' } });
  await assert.rejects(
    () => queryPulseDimensionDistinctCount(session, { datasourceLuid: 'datasource-1', fieldName: 'Region' }),
    /returned an error/,
  );
  for (const data of [[['not-a-number']], [[]], [], [[1], [2]]]) {
    globalThis.fetch = async () => Response.json({ data });
    await assert.rejects(
      () => queryPulseDimensionDistinctCount(session, { datasourceLuid: 'datasource-1', fieldName: 'Region' }),
      /distinct-count/,
    );
  }
});

test('VDS distinct query rejects partial data accompanied by a provider error', async () => {
  globalThis.fetch = async () => Response.json({
    data: [['Central']],
    error: { message: 'stream interrupted' },
  });
  await assert.rejects(() => queryPulseDimensionValues(session, {
    datasourceLuid: 'datasource-1',
    fieldName: 'Region',
    rowLimit: 1_000,
  }), /returned an error/);
});

test('VDS distinct query rejects rows outside the captured one-column string-or-null contract', async () => {
  for (const data of [
    [[123]],
    [['Central', 'West']],
    [{ value: 'Central' }],
  ]) {
    globalThis.fetch = async () => Response.json({ data });
    await assert.rejects(() => queryPulseDimensionValues(session, {
      datasourceLuid: 'datasource-1',
      fieldName: 'Region',
      rowLimit: 1_000,
    }), /unsupported row shape/);
  }
});


test('follower inventory reads every subscription page and stops repeated continuation after two sends', async () => {
  let calls = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls++;
    return Response.json(url.searchParams.has('page_token')
      ? { subscriptions: [{ id: 'second', follower: { group_id: 'group' } }] }
      : { subscriptions: [{ id: 'first', follower: { user_id: 'user' } }], next_page_token: 'more' });
  };
  const subscriptions = await listSubscriptionsForMetric(session, 'metric');
  assert.equal(subscriptions.length, 2); assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ subscriptions: [{ id: 'first', follower: { user_id: 'user' } }], next_page_token: 'repeat' }); };
  await assert.rejects(() => listSubscriptionsForMetric(session, 'metric'), /invalid continuation/i);
  assert.equal(calls, 2, 'A repeated token stops before a third provider send.');
});

test('follower inventory rejects an empty continuation page without another send', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ subscriptions: [], next_page_token: 'more' }); };
  await assert.rejects(() => listSubscriptionsForMetric(session, 'metric'), /invalid continuation/i);
  assert.equal(calls, 1);
});

test('follower inventory distinguishes local page and record limits from invalid continuation', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ subscriptions: [{ id: `subscription-${calls}`, follower: { user_id: 'user' } }], next_page_token: `page-${calls}` }); };
  await assert.rejects(() => listSubscriptionsForMetric(session, 'metric'), /local page limit/i);
  assert.equal(calls, 20, 'The local page bound prevents a twenty-first provider send.');
  calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ subscriptions: Array.from({ length: 2000 }, (_, index) => ({ id: `subscription-${index}`, follower: { user_id: `user-${index}` } })), next_page_token: 'more' }); };
  await assert.rejects(() => listSubscriptionsForMetric(session, 'metric'), /local record limit/i);
  assert.equal(calls, 1, 'A provider page that reaches the record bound prevents another send.');
});
