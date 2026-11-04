import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { runWithTableauTelemetry, type TableauSession } from '@pulse-metric-studio/core';
import { getExistingMetrics, clearInventoryCache } from '../application/inventory.js';
import { PulseDimensionalForkService } from './dimensional-fork-service.js';
import { getOrCreatePulseMetric, listSubscriptionsForMetric } from './pulse-client.js';

const metricId = '10000000-0000-4000-8000-000000000001';
const secondMetricId = '10000000-0000-4000-8000-000000000002';
const definitionId = '20000000-0000-4000-8000-000000000001';
const session: TableauSession = {
  serverUrl: 'https://example.test', siteContentUrl: 'private-site',
  siteId: 'site-id', userId: 'private-user', token: 'private-token', apiVersion: '3.27',
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearInventoryCache(); });

function capture<T>(callback: () => Promise<T>) {
  const records: Record<string, unknown>[] = [];
  return { records, result: runWithTableauTelemetry({ reqId: 'diagnostic-test', log: (record) => { records.push(record); } }, callback) };
}

test('get-or-create diagnostics distinguish created, existing, and missing IDs without exposing payloads', async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json({
    metric: { metadata: { ...(calls < 2 ? { id: metricId } : {}), name: 'private-metric-name' } },
    is_metric_created: calls++ === 0,
    credentials: 'private-response-secret',
  });
  const { records, result } = capture(async () => {
    for (let index = 0; index < 3; index++) await getOrCreatePulseMetric(session, {
      definitionId, specification: { filters: [{ field: 'private-field', values: ['private-filter-value'] }] },
    });
  });
  await result;
  const outcomes = records.filter((record) => record.event === 'tableau.get_or_create');
  assert.deepEqual(outcomes.map(({ metricId: id, isMetricCreated }) => ({ metricId: id, isMetricCreated })), [
    { metricId, isMetricCreated: true }, { metricId, isMetricCreated: false }, { metricId: null, isMetricCreated: false },
  ]);
  assert.equal(records.filter((record) => record.event === 'tableau.attempt').length, 3);
  assert.ok(records.every((record) => record.reqId === 'diagnostic-test'));
  assert.doesNotMatch(JSON.stringify(records), /private-/);
});

test('inventory diagnostics report list completeness and attribute only hydration fallbacks to exact reads', async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: definitionId }, specification: { datasource: { id: 'datasource' } } }] });
    if (path.endsWith('/metrics')) return Response.json({ metrics: [
      { id: metricId, definition_id: definitionId, is_default: false, specification: { filters: [] } },
      { id: secondMetricId, definition_id: definitionId, metric_specification: { filters: [] } },
    ] });
    return Response.json({ metric: { id: secondMetricId, definition_id: definitionId, is_default: false, specification: { filters: [] } } });
  };
  const { records, result } = capture(() => getExistingMetrics(session, 'datasource'));
  assert.equal((await result).definitions[0]?.metrics.length, 2);
  const listing = records.find((record) => record.event === 'tableau.inventory_listing');
  assert.equal(listing?.metricCount, 2);
  assert.equal(listing?.specificationCount, 1);
  assert.equal(listing?.metricSpecificationCount, 1);
  assert.equal(listing?.usableSpecificationCount, 2);
  assert.equal(listing?.isDefaultCount, 1);
  assert.equal(records.filter((record) => record.event === 'tableau.attempt' && record.operation === 'inventory_get_metric').length, 1);
});

test('subscription diagnostics retain paging counts and metric identity without follower identities or query tokens', async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json({
    subscriptions: [{ id: 'private-subscription', follower: { id: 'private-follower', type: 'USER', name: 'private-name' } }],
    ...(calls++ === 0 ? { next_page_token: 'private-page-token' } : {}),
  });
  const { records, result } = capture(() => listSubscriptionsForMetric(session, metricId));
  assert.equal((await result).length, 2);
  assert.deepEqual(records.filter((record) => record.event === 'tableau.subscriptions_page').map((record) => ({
    metricId: record.metricId, page: record.page, recordCount: record.recordCount, hasNextPage: record.hasNextPage,
  })), [
    { metricId, page: 1, recordCount: 1, hasNextPage: true },
    { metricId, page: 2, recordCount: 1, hasNextPage: false },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /private-|\?/);
});

test('dimension diagnostics identify warm context reuse without logging fields or selected values', async () => {
  const calls = { metric: 0, definition: 0, catalog: 0, values: 0, count: 0 };
  const dimensions = new PulseDimensionalForkService({
    getMetric: async () => { calls.metric++; return { id: metricId, definition_id: definitionId, specification: {} }; },
    getDefinition: async () => { calls.definition++; return { specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['private-field'] } }; },
    getCatalog: async () => {
      calls.catalog++;
      return { datasourceLuid: 'datasource', datasourceName: 'private-datasource', measures: [], timeDimensions: [], parameters: [], excluded: [], source: 'vds', warnings: [], dimensions: [{ id: 'private-field', name: 'private-field', label: 'private-field', caption: 'private-field', role: 'DIMENSION', dataType: 'STRING', table: null, defaultAggregation: null, formula: null, requiresUserAgg: false }] };
    },
    queryValues: async () => { calls.values++; return [['private-value']]; },
    queryCount: async () => { calls.count++; return 1; },
  });
  const { records, result } = capture(async () => {
    await dimensions.listEligibleDimensions(session, [metricId]);
    await dimensions.countDimensionMembers(session, { sourceMetricIds: [metricId], fieldId: 'private-field' });
    await dimensions.listDimensionValues(session, { sourceMetricIds: [metricId], fieldId: 'private-field' });
  });
  await result;
  assert.deepEqual(calls, { metric: 1, definition: 1, catalog: 1, values: 1, count: 1 });
  assert.deepEqual(records.map((record) => record.cacheHit), [false, true, true]);
  assert.doesNotMatch(JSON.stringify(records), /private-/);
});
