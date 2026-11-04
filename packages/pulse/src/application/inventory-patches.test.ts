import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { beginInventoryMutation, getPulseInventorySnapshot, loadPulseInventory, patchPulseInventory } from './inventory-snapshots.js';
import { exactMetricVariant } from './inventory.js';
import { PulseDeletionService } from './deletion.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test('older dispatched refresh cannot replace a newer authoritative inventory or receipt', async () => {
  const originalFetch = globalThis.fetch;
  const session: TableauSession = { serverUrl: 'https://refresh.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  const owner = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: 'site', datasourceLuid: 'datasource' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  const pending = gate(), started = gate(); let lists = 0;
  const source = { id: 'source', definition_id: 'definition', is_default: false, specification: { filters: [] } };
  globalThis.fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }] });
    const read = ++lists; if (read === 2) { started.resolve(); await pending.promise; }
    return Response.json({ metrics: read === 3 ? [source, { ...source, id: 'remote' }] : [source] });
  };
  try {
    await loadPulseInventory(session, 'datasource', { refresh: true });
    const a = loadPulseInventory(session, 'datasource', { refresh: true }); await started.promise;
    const b = await loadPulseInventory(session, 'datasource', { refresh: true }); pending.resolve(); await a;
    const patch = patchPulseInventory(session, owner, b.snapshotId, { upserts: [{ definitionId: 'definition', metric: exactMetricVariant('local', {}, source) }], removedMetricIds: [], removedDefinitionIds: [] })!;
    assert.deepEqual(getPulseInventorySnapshot(session, owner, patch.snapshotId).definitions[0]!.metrics.map(row => row.metricId), ['source', 'remote', 'local']);
    assert.equal(patch.lifetimeId, b.lifetimeId);
    assert.deepEqual(patch.inventory, getPulseInventorySnapshot(session, owner, patch.snapshotId));
    const later = patchPulseInventory(session, owner, b.snapshotId, { upserts: [], removedMetricIds: ['source'], removedDefinitionIds: [] })!;
    assert.deepEqual(later.inventory!.definitions[0]!.metrics.map(row => row.metricId), ['remote', 'local']);
    assert.ok(later.revision > patch.revision);
    assert.equal(lists, 3);
  } finally { pending.resolve(); globalThis.fetch = originalFetch; clearSession(); }
});
test('local patches rebase pending refreshes, preserve reviewed evidence and fence older create results after deletion', async () => {
  const originalFetch = globalThis.fetch;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'patch-user', token: 'token', apiVersion: '3.27' };
  const owner = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: 'site', datasourceLuid: 'datasource' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  const pending = gate(), started = gate(); let lists = 0;
  const source = { id: 'source', definition_id: 'definition', is_default: false, specification: { filters: [] } };
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/definitions')) return Response.json({ definitions: [{ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: [] } }] });
    if (++lists === 2) { started.resolve(); await pending.promise; }
    return Response.json({ metrics: [source] });
  };
  try {
    const base = await loadPulseInventory(session, 'datasource', { refresh: true });
    const reviewed = await new PulseDeletionService().preview({ context: owner, snapshotId: base.snapshotId, metricIds: ['source'], definitionIds: [], allowIncompleteInventory: false });
    const admitted = beginInventoryMutation(session, owner, base.snapshotId);
    const refresh = loadPulseInventory(session, 'datasource', { refresh: true }); await started.promise;
    const row = exactMetricVariant('new', {}, { id: 'new', definition_id: 'definition', is_default: false, specification: { filters: [] } });
    const created = patchPulseInventory(session, owner, base.snapshotId, { upserts: [{ definitionId: 'definition', metric: row }], removedMetricIds: [], removedDefinitionIds: [] }, admitted)!;
    const deleted = patchPulseInventory(session, owner, created.snapshotId, { upserts: [], removedMetricIds: ['source'], removedDefinitionIds: [] })!;
    pending.resolve(); const fresh = await refresh;
    assert.deepEqual(fresh.definitions[0]!.metrics.map(metric => metric.metricId), ['new']);
    assert.ok(fresh.revision! > deleted.revision);
    assert.deepEqual(getPulseInventorySnapshot(session, owner, base.snapshotId).definitions[0]!.metrics.map(metric => metric.metricId), ['source']);
    assert.equal((await new PulseDeletionService().preview({ context: owner, snapshotId: base.snapshotId, metricIds: ['source'], definitionIds: [], allowIncompleteInventory: false })).previewFingerprint, reviewed.previewFingerprint);
    const newReview = await new PulseDeletionService().preview({ context: owner, snapshotId: fresh.snapshotId, metricIds: ['new'], definitionIds: [], allowIncompleteInventory: false });
    assert.deepEqual(newReview.targets[0]!.affectedMetricIds, ['new']);
    const oldCreate = patchPulseInventory(session, owner, base.snapshotId, { upserts: [{ definitionId: 'definition', metric: exactMetricVariant('source', {}, source) }], removedMetricIds: [], removedDefinitionIds: [] }, admitted)!;
    assert.deepEqual(oldCreate.upserts, []);
    assert.deepEqual(getPulseInventorySnapshot(session, owner, oldCreate.snapshotId).definitions[0]!.metrics.map(metric => metric.metricId), ['new']);
    assert.equal(lists, 2, 'All patching and deletion review stays local.');
  } finally { pending.resolve(); globalThis.fetch = originalFetch; clearSession(); }
});
