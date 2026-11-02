import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { listMetricsForDefinition, listMetricsInventory } from './pulse-client.js';
import { clearInventoryCache } from '../application/inventory.js';
import { getPulseInventorySnapshot, loadPulseInventory } from '../application/inventory-snapshots.js';
import { PulseDeletionService } from '../application/deletion.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
beforeEach(() => setSession(session, { connectionId: 'connection', patSecret: '' }));
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); clearInventoryCache(); });

test('metric lists consume continuation pages and deduplicate metric IDs', async () => {
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    return Response.json(url.searchParams.has('page_token')
      ? { metrics: [{ id: 'metric-a' }, { id: 'metric-b' }], total_available: 2 }
      : { metrics: [{ id: 'metric-a' }], total_available: 2, next_page_token: 'next' });
  };
  assert.deepEqual((await listMetricsForDefinition(session, 'definition')).map((metric) => metric.id), ['metric-a', 'metric-b']);
  assert.equal(paths.length, 2);
  assert.match(paths[1]!, /page_token=next/);
});

test('a missing advertised metric page is retained as partial deletion authority', async () => {
  setSession(session, { connectionId: 'connection', patSecret: '' });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }] });
    if (url.pathname.endsWith('/metrics')) return Response.json({ metrics: [{ id: 'metric-a' }], total_available: 2 });
    return Response.json({ metric: { id: 'metric-a', definition_id: 'definition', specification: { filters: [] } } });
  };
  const displayed = await loadPulseInventory(session, 'datasource');
  const retained = getPulseInventorySnapshot(session, { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' }, displayed.snapshotId);
  assert.equal(retained.definitions[0]!.inventoryStatus, 'partial');
  assert.equal(retained.truncated, true);
  assert.equal(retained.definitions[0]!.metrics.length, 1);
  const request = { context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' }, snapshotId: displayed.snapshotId, definitionIds: ['definition'], metricIds: [], allowIncompleteInventory: false };
  let reviewReads = 0;
  globalThis.fetch = async () => { reviewReads++; throw new Error('review must use the snapshot'); };
  const service = new PulseDeletionService();
  await assert.rejects(service.preview(request), /complete current inventory/);
  const plan = await service.preview({ ...request, allowIncompleteInventory: true });
  assert.equal(plan.targets[0]!.inventoryComplete, false);
  assert.deepEqual(plan.targets[0]!.affectedMetricIds, ['metric-a']);
  assert.equal(reviewReads, 0);
});

for (const scenario of ['failure', 'repeat', 'malformed', 'page-limit', 'item-limit'] as const) {
  test(`metric pagination preserves useful partial results for ${scenario}`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls > 1 && scenario === 'failure') return new Response('not available', { status: 400 });
      if (calls > 1 && scenario === 'malformed') return Response.json({ metrics: 'bad' });
      return Response.json({ metrics: [{ id: `metric-${calls}` }], next_page_token: 'repeat' });
    };
    const result = await listMetricsInventory(session, 'definition', { maxPages: scenario === 'page-limit' ? 1 : 5, maxItems: scenario === 'item-limit' ? 1 : 100 });
    assert.equal(result.truncated, true);
    assert.ok(result.metrics.length >= 1);
    assert.ok(result.diagnostic?.message);
    assert.equal(calls, scenario === 'page-limit' ? 1 : 2);
  });
}
