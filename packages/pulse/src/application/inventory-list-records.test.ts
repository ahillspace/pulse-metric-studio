import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { clearInventoryCache, getExistingMetrics } from './inventory.js';
import { getFollowState } from './subscriptions.js';
import { loadPulseInventory } from './inventory-snapshots.js';
import { PulseDeletionService } from './deletion.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
beforeEach(() => { clearInventoryCache(); setSession(session, { connectionId: 'connection', patSecret: '' }); });
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); clearInventoryCache(); });

for (const size of [2, 200, 405]) {
  test(`inventory reuses ${size} complete metric list records with zero exact reads`, async () => {
    let lists = 0;
    let exact = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }] });
      if (url.pathname.endsWith('/metrics')) {
        lists++;
        const start = Number(url.searchParams.get('page_token') ?? 0);
        const end = Math.min(start + 100, size);
        return Response.json({ metrics: Array.from({ length: end - start }, (_, index) => ({ id: `metric-${start + index}`, definition_id: 'definition', site_id: 'site', is_default: false, specification: { filters: [], measurement_period: { range: 'RANGE_CURRENT_PARTIAL', granularity: 'GRANULARITY_BY_MONTH' } } })), total_available: size, ...(end < size ? { next_page_token: String(end) } : {}) });
      }
      exact++;
      throw new Error('complete records require no exact GET');
    };
    const inventory = await getExistingMetrics(session, 'datasource');
    assert.equal(inventory.definitions[0]!.metrics.length, size);
    assert.equal(inventory.definitions[0]!.inventoryStatus, 'complete');
    assert.equal(exact, 0);
    assert.equal(lists, Math.ceil(size / 100));
  });
}

test('missing list fields use exact reads while mismatched ownership is rejected', async () => {
  const exactIds: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }] });
    if (url.pathname.endsWith('/metrics')) return Response.json({ metrics: [{ id: 'missing' }, { id: 'mismatch', definition_id: 'other', specification: {} }] });
    exactIds.push(url.pathname.split('/').at(-1)!);
    return Response.json({ metric: { id: 'missing', definition_id: 'definition', specification: { filters: [] } } });
  };
  const result = await getExistingMetrics(session, 'datasource');
  assert.deepEqual(exactIds, ['missing']);
  assert.equal(result.definitions[0]!.inventoryStatus, 'partial');
  assert.equal(result.failures[0]!.metricId, 'mismatch');
});

for (const flag of [undefined, 'false']) {
  test(`a ${flag === undefined ? 'missing' : 'malformed'} list default flag hydrates authoritative variant deletion eligibility`, async () => {
    let exact = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }] });
      if (url.pathname.endsWith('/metrics')) return Response.json({ metrics: [{ id: 'metric', definition_id: 'definition', specification: { filters: [] }, ...(flag === undefined ? {} : { is_default: flag }) }] });
      exact++;
      return Response.json({ metric: { id: 'metric', definition_id: 'definition', is_default: false, specification: { filters: [] } } });
    };
    const inventory = await loadPulseInventory(session, 'datasource');
    assert.equal(exact, 1);
    assert.equal(inventory.definitions[0]!.metrics[0]!.isDefault, false);
    const plan = await new PulseDeletionService().preview({ context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' }, snapshotId: inventory.snapshotId, definitionIds: [], metricIds: ['metric'], allowIncompleteInventory: false });
    assert.equal(plan.targets[0]!.kind, 'metric');
    assert.equal(exact, 1);
  });
}

test('20 definitions and 200 complete metrics need 22 initial count-summary requests', async () => {
  const counts = { definitions: 0, lists: 0, exact: 0, identities: 0, membership: 0, counts: 0 };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/definitions')) {
      counts.definitions++;
      return Response.json({ definitions: Array.from({ length: 20 }, (_, index) => ({ metadata: { id: `definition-${index}` }, specification: { datasource: { id: 'datasource' } } })) });
    }
    const match = url.pathname.match(/definitions\/(definition-\d+)\/metrics$/);
    if (match) {
      counts.lists++;
      return Response.json({ metrics: Array.from({ length: 10 }, (_, index) => ({ id: `${match[1]}-metric-${index}`, definition_id: match[1], is_default: false, specification: { filters: [] } })) });
    }
    if (url.pathname.endsWith('subscriptions:batchGetMetricFollowerCounts')) {
      counts.counts++;
      return Response.json({ follower_counts: url.searchParams.get('metric_ids')!.split(',').map((metric_id) => ({ metric_id, follower_count: 0 })) });
    }
    if (url.pathname.endsWith('/subscriptions')) counts.identities++;
    else if (url.pathname.endsWith('/groups')) counts.membership++;
    else counts.exact++;
    throw new Error('Initial count summary must not load these resources.');
  };
  const inventory = await getExistingMetrics(session, 'datasource');
  const ids = inventory.definitions.flatMap((definition) => definition.metrics.map((metric) => metric.metricId));
  assert.equal(ids.length, 200);
  await getFollowState(session, session.userId, [], ids, { detail: false });
  assert.deepEqual(counts, { definitions: 1, lists: 20, exact: 0, identities: 0, membership: 0, counts: 1 });
});
