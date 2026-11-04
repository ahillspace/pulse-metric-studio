import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { clearInventoryCache } from './inventory.js';
import { getPulseInventorySnapshot, loadPulseInventory } from './inventory-snapshots.js';
import { PulseApplicationError } from './errors.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = {
  serverUrl: 'https://tableau.example.test', siteContentUrl: 'site', siteId: 'site',
  userId: 'user', token: 'test-only-token', apiVersion: '3.27',
};
const owner = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' };
let reads = 0;
beforeEach(() => {
  reads = 0;
  clearInventoryCache();
  setSession(session, { connectionId: owner.connectionId, patSecret: '' });
  globalThis.fetch = async (input) => {
    reads++;
    const url = new URL(String(input));
    assert.equal(url.origin, session.serverUrl);
    if (url.pathname === '/api/-/pulse/definitions')
      return Response.json({ definitions: [{ metadata: { id: 'definition', name: 'Original' }, specification: { datasource: { id: 'datasource' } } }] });
    if (url.pathname === '/api/-/pulse/definitions/definition/metrics')
      return Response.json({ metrics: [{ id: 'metric', is_default: false }] });
    assert.equal(url.pathname, '/api/-/pulse/metrics/metric');
    return Response.json({ metric: { id: 'metric', definition_id: 'definition', specification: { filters: [] } } });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); clearInventoryCache(); });

test('displayed inventory and snapshot reads cannot mutate retained deletion authority', async () => {
  const displayed = await loadPulseInventory(session, owner.datasourceLuid);
  const snapshotId = displayed.snapshotId;
  displayed.definitions[0]!.name = 'Invented';
  displayed.definitions[0]!.metrics[0]!.metricId = 'unrelated';
  const first = getPulseInventorySnapshot(session, owner, snapshotId);
  assert.equal(first.definitions[0]!.name, 'Original');
  assert.equal(first.definitions[0]!.metrics[0]!.metricId, 'metric');
  first.definitions.length = 0;
  assert.equal(getPulseInventorySnapshot(session, owner, snapshotId).definitions.length, 1);
  assert.equal(reads, 3);
});

test('bounded snapshot retention evicts old inventory without a provider fallback', async () => {
  const first = await loadPulseInventory(session, owner.datasourceLuid);
  let latest = first;
  for (let index = 0; index < 32; index++) latest = await loadPulseInventory(session, owner.datasourceLuid);
  const beforeLookup = reads;
  assert.throws(() => getPulseInventorySnapshot(session, owner, first.snapshotId),
    (error: unknown) => error instanceof PulseApplicationError && error.code === 'delete_snapshot_unavailable' && /refresh/i.test(error.message));
  assert.equal(getPulseInventorySnapshot(session, owner, latest.snapshotId).snapshotId, latest.snapshotId);
  assert.equal(reads, beforeLookup);
});

test('snapshot acquisition rejects a stale session before provider access', async () => {
  clearSession();
  await assert.rejects(loadPulseInventory(session, owner.datasourceLuid),
    (error: unknown) => error instanceof PulseApplicationError && error.statusCode === 401);
  assert.equal(reads, 0);
});

test('reactivating the same session object invalidates its earlier snapshot generation without provider reads', async () => {
  const displayed = await loadPulseInventory(session, owner.datasourceLuid);
  const beforeReactivation = reads;
  setSession(session, { connectionId: owner.connectionId, patSecret: '' });
  assert.throws(() => getPulseInventorySnapshot(session, owner, displayed.snapshotId),
    (error: unknown) => error instanceof PulseApplicationError && error.code === 'delete_snapshot_unavailable');
  assert.equal(reads, beforeReactivation);
});

test('reactivation at identical coordinates reloads the definition inventory for the new generation', async () => {
  await loadPulseInventory(session, owner.datasourceLuid);
  const before = reads;
  setSession(session, { connectionId: owner.connectionId, patSecret: '' });
  await loadPulseInventory(session, owner.datasourceLuid);
  assert.equal(reads - before, 3);
});


test('owner-state eviction starts a unique revision lifetime', async () => {
  const first = await loadPulseInventory(session, owner.datasourceLuid);
  for (let index = 0; index < 32; index++) await loadPulseInventory(session, `other-datasource-${index}`);
  const replacement = await loadPulseInventory(session, owner.datasourceLuid);
  assert.ok(first.lifetimeId);
  assert.ok(replacement.lifetimeId);
  assert.notEqual(first.lifetimeId, replacement.lifetimeId);
  assert.equal(replacement.revision, 1);
});
