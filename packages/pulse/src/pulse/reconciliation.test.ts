import { TableauError,type TableauSession } from '@pulse-metric-studio/core';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
reconcileMetricOwnership,
createMetricReconciliationOperation,
type MetricReconciliationDependencies,
} from './reconciliation.js';
import { listMetricsInventory } from './pulse-client.js';

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

test('visibility lag retries only listings after exact ownership succeeds', async () => {
  const calls = { metric: 0, definition: 0, listing: 0 };
  const base = dependencies();
  const result = await reconcileMetricOwnership(session, { metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1' }, dependencies({
    getMetric: async (owner, id) => { calls.metric++; return base.getMetric(owner, id); },
    getDefinition: async (owner, id) => { calls.definition++; return base.getDefinition(owner, id); },
    listMetrics: async () => { calls.listing++; return calls.listing === 5 ? [{ id: 'metric-1' }] : []; },
  }), [0, 0, 0, 0, 0]);
  assert.equal(result.status, 'visible');
  assert.deepEqual(calls, { metric: 1, definition: 1, listing: 5 });
});

test('one operation shares parent ownership and compatible listing evidence between metrics', async () => {
  let parents = 0;
  let listings = 0;
  const reconcile = createMetricReconciliationOperation(session, dependencies({
    getMetric: async (_owner, id) => ({ id, definition_id: 'definition-1', specification: {} }),
    getDefinition: async () => { parents++; return { specification: { datasource: { id: 'datasource-1' } } }; },
    listMetrics: async () => { listings++; await new Promise<void>((resolve) => setImmediate(resolve)); return [{ id: 'metric-1' }, { id: 'metric-2' }]; },
  }));
  const results = await Promise.all(['metric-1', 'metric-2'].map((metricId) => reconcile({ metricId, definitionId: 'definition-1', datasourceLuid: 'datasource-1' })));
  assert.ok(results.every((result) => result.status === 'visible'));
  assert.equal(parents, 1);
  assert.equal(listings, 1);
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

test('partial visibility inventory proves presence but never proves an omitted metric absent', async () => {
  for (const present of [true, false]) {
    let listings = 0;
    const result = await reconcileMetricOwnership(session, { metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1' }, dependencies({
      listMetrics: async () => {
        listings++;
        return { metrics: present ? [{ id: 'metric-1' }] : [], truncated: true, diagnostic: { message: 'A later metric page failed.' } };
      },
    }), [0, 0]);
    assert.equal(result.status, present ? 'visible' : 'failed');
    assert.equal(result.ownershipVerified, true);
    assert.equal(result.attempts, 1);
    assert.equal(listings, 1);
    if (!present) assert.match(result.diagnostic!.message, /later metric page/);
  }
});

for (const status of [403, 429, 503]) {
  test(`visibility reconciliation does not restart transport retries after HTTP ${status}`, async () => {
    const originalFetch = globalThis.fetch;
    const calls = { listing: 0, http: 0, waits: [] as number[] };
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.method ?? 'GET', 'GET');
      const url = new URL(String(input));
      assert.equal(url.origin, session.serverUrl);
      assert.equal(url.pathname, '/api/-/pulse/definitions/definition-1/metrics');
      calls.http++;
      return Response.json({ error: { summary: 'Fixture inventory rejected.' } }, {
        status,
        headers: { 'Retry-After': '0' },
      });
    };
    try {
      const result = await reconcileMetricOwnership(session, {
        metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1',
      }, dependencies({
        listMetrics: async (owner, id) => { calls.listing++; return listMetricsInventory(owner, id); },
        wait: async (ms) => { calls.waits.push(ms); },
      }));
      assert.equal(calls.http, status === 429 ? 5 : 1, 'Only the transport may retry a rejected request.');
      assert.equal(calls.listing, 1);
      assert.deepEqual(calls.waits, []);
      assert.equal(result.status, 'failed');
      assert.equal(result.diagnostic?.status, status);
      assert.equal(result.exactMetricResolved, true);
      assert.equal(result.ownershipVerified, true);
      assert.equal(result.inventoryVisible, false);
      assert.equal(result.attempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('later-page throttling preserves partial visibility diagnostics without restarting the listing', async () => {
  const originalFetch = globalThis.fetch;
  let http = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    const url = new URL(String(input));
    assert.equal(url.origin, session.serverUrl);
    assert.equal(url.pathname, '/api/-/pulse/definitions/definition-1/metrics');
    http++;
    if (!url.searchParams.has('page_token')) {
      return Response.json({ metrics: [{ id: 'another-metric' }], next_page_token: 'next-page' });
    }
    assert.equal(url.searchParams.get('page_token'), 'next-page');
    return Response.json({ error: { summary: 'Fixture later page rejected.' } }, {
      status: 429, headers: { 'Retry-After': '0' },
    });
  };
  try {
    const result = await reconcileMetricOwnership(session, {
      metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1',
    }, dependencies({ listMetrics: listMetricsInventory }));
    assert.equal(http, 6, 'The successful first page and five rejected attempts must not restart.');
    assert.equal(result.status, 'failed');
    assert.equal(result.diagnostic?.status, 429);
    assert.match(result.diagnostic?.detail ?? '', /Fixture later page rejected/);
    assert.equal(result.exactMetricResolved, true);
    assert.equal(result.ownershipVerified, true);
    assert.equal(result.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a missing listing can become visible without repeating successful ownership reads', async () => {
  const calls = { metric: 0, definition: 0, listing: 0 };
  const base = dependencies();
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1',
  }, dependencies({
    getMetric: async (owner, id) => { calls.metric++; return base.getMetric(owner, id); },
    getDefinition: async (owner, id) => { calls.definition++; return base.getDefinition(owner, id); },
    listMetrics: async () => {
      calls.listing++;
      if (calls.listing === 1) throw new TableauError('Fixture listing not yet visible.', 404);
      return calls.listing === 2 ? [] : [{ id: 'metric-1' }];
    },
  }), [0, 0, 0]);
  assert.equal(result.status, 'visible');
  assert.equal(result.ownershipVerified, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(calls, { metric: 1, definition: 1, listing: 3 });
});

test('healthy empty listings remain pending after a missing listing becomes available', async () => {
  let listings = 0;
  const result = await reconcileMetricOwnership(session, {
    metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1',
  }, dependencies({
    listMetrics: async () => {
      if (++listings === 1) throw new TableauError('Fixture listing not yet visible.', 404);
      return [];
    },
  }), [0, 0, 0]);
  assert.equal(result.status, 'pending_visibility');
  assert.equal(result.diagnostic, undefined);
  assert.equal(result.ownershipVerified, true);
  assert.equal(result.attempts, 3);
  assert.equal(listings, 3);
});

test('authentication loss during listing still terminates reconciliation', async () => {
  const error = new TableauError('Fixture session ended.', 401, '', 'auth');
  let listings = 0;
  await assert.rejects(reconcileMetricOwnership(session, {
    metricId: 'metric-1', definitionId: 'definition-1', datasourceLuid: 'datasource-1',
  }, dependencies({
    listMetrics: async () => { listings++; throw error; },
  })), (failure) => failure === error);
  assert.equal(listings, 1);
});
