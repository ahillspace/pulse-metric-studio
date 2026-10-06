import { TableauError,type TableauSession } from '@pulse-metric-studio/core';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
reconcileMetricOwnership,
type MetricReconciliationDependencies,
} from './reconciliation.js';

const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

function dependencies(overrides: Partial<MetricReconciliationDependencies> = {}): MetricReconciliationDependencies {
  return {
    getMetric: async () => ({ id: 'metric-1', definition_id: 'definition-1', site_id: 'site-id', specification: {} }),
    getDefinition: async () => ({ specification: { datasource: { id: 'datasource-1' } } }),
    listMetrics: async () => [{ id: 'metric-1' }],
    wait: async () => {},
    ...overrides,
  };
}

test('exact-ID reconciliation verifies site, definition, datasource, and inventory visibility', async () => {
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1',
    definitionId: 'definition-1',
    datasourceLuid: 'datasource-1',
  }, dependencies(), [0]);
  assert.deepEqual(result, {
    metricId: 'metric-1',
    status: 'visible',
    exactMetricResolved: true,
    inventoryVisible: true,
    ownershipVerified: true,
    attempts: 1,
  });
});

test('exact-ID reconciliation reports pending visibility after bounded polling', async () => {
  let metricCalls = 0;
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1',
    definitionId: 'definition-1',
    datasourceLuid: 'datasource-1',
  }, dependencies({
    getMetric: async () => {
      metricCalls++;
      if (metricCalls === 1) throw new TableauError('not found', 404);
      return { id: 'metric-1', definition_id: 'definition-1', specification: {} };
    },
    listMetrics: async () => [],
  }), [0, 0, 0]);
  assert.equal(result.status, 'pending_visibility');
  assert.equal(result.exactMetricResolved, true);
  assert.equal(result.ownershipVerified, true);
  assert.equal(result.inventoryVisible, false);
  assert.equal(result.attempts, 3);
});

test('exact-ID reconciliation rejects ownership mismatches', async () => {
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1',
    definitionId: 'definition-1',
    datasourceLuid: 'datasource-1',
  }, dependencies({
    getMetric: async () => ({ id: 'metric-1', definition_id: 'other-definition', specification: {} }),
  }), [0]);
  assert.equal(result.status, 'ownership_mismatch');
  assert.equal(result.ownershipVerified, false);
  assert.match(result.diagnostic?.message ?? '', /other-definition/);
});

test('exact-ID reconciliation keeps bounded provider diagnostics for inventory failures', async () => {
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1',
    definitionId: 'definition-1',
    datasourceLuid: 'datasource-1',
  }, dependencies({
    listMetrics: async () => {
      throw new TableauError('inventory failed', 503, 'x'.repeat(2_000));
    },
  }), [0, 0]);
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnostic?.status, 503);
  assert.ok((result.diagnostic?.detail?.length ?? 0) <= 800);
});
