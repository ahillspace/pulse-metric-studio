import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { clearSession, setSession, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { executeDeletes, type ExecuteDeletesDependencies } from './delete-execution.js';
import { PulseDeletionService } from './deletion.js';
import { clearInventoryCache } from './inventory.js';
import { getPulseInventorySnapshot, loadPulseInventory } from './inventory-snapshots.js';

const session: TableauSession = {
  serverUrl: 'https://tableau.example.test', siteContentUrl: 'site', siteId: 'site',
  userId: 'user', token: 'test-only-token', apiVersion: '3.27',
};
const context = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' };
const metricIds = Array.from({ length: 12 }, (_, index) => `metric-${String(index + 1).padStart(2, '0')}`);
const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearInventoryCache();
  setSession(session, { connectionId: context.connectionId, patSecret: '' });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSession();
  clearInventoryCache();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function reviewedDeletion(deleteMetric?: ExecuteDeletesDependencies['deleteMetric']) {
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    reads++;
    const url = new URL(String(input));
    assert.equal(url.origin, session.serverUrl);
    if (url.pathname === '/api/-/pulse/definitions')
      return Response.json({ definitions: [{ metadata: { id: 'definition', name: 'Sales' }, specification: { datasource: { id: context.datasourceLuid } } }] });
    assert.equal(url.pathname, '/api/-/pulse/definitions/definition/metrics');
    return Response.json({ metrics: metricIds.map(id => ({
      id, definition_id: 'definition', is_default: false,
      specification: { filters: [], measurement_period: {} },
    })) });
  };
  const displayed = await loadPulseInventory(session, context.datasourceLuid);
  assert.equal(reads, 2);
  globalThis.fetch = async () => assert.fail('Deletion must not read Tableau after the displayed inventory loads.');
  const service = new PulseDeletionService({
    inventory: getPulseInventorySnapshot,
    execute: deleteMetric ? (owner, entries) => executeDeletes(owner, entries, {
      deleteDefinition: async () => assert.fail('Variant deletion must not delete its definition.'),
      deleteMetric,
    }) : executeDeletes,
  });
  const request = { context, snapshotId: displayed.snapshotId, metricIds, definitionIds: [], allowIncompleteInventory: false };
  const plan = await service.preview(request);
  assert.equal(plan.targets.length, metricIds.length);
  return () => service.execute({
    ...request,
    previewFingerprint: plan.previewFingerprint,
  });
}

test('reviewed metric deletion waits for each group of five before sending the next group', async () => {
  const gates = new Map(metricIds.map(id => [id, deferred()]));
  const calls: string[] = [];
  const start = await reviewedDeletion(async (_owner, id) => {
    calls.push(id);
    await gates.get(id)!.promise;
  });
  const operation = start();
  try {
    await setImmediate();
    assert.deepEqual(calls, metricIds.slice(0, 5));
    gates.get(metricIds[1]!)!.reject(new TableauError('Permission denied.', 403));
    for (const id of metricIds.slice(2, 5)) gates.get(id)!.resolve();
    await setImmediate();
    assert.deepEqual([...calls], metricIds.slice(0, 5), 'A completed request must not release the next group while its first request remains pending.');

    gates.get(metricIds[0]!)!.resolve();
    await setImmediate();
    assert.deepEqual(calls, metricIds.slice(0, 10));
    gates.get(metricIds[6]!)!.reject(new TableauError('Retry budget exhausted.', 429));
    for (const id of metricIds.slice(7, 10)) gates.get(id)!.resolve();
    await setImmediate();
    assert.deepEqual(calls, metricIds.slice(0, 10), 'The final group must wait for every request in the second group.');

    gates.get(metricIds[5]!)!.resolve();
    await setImmediate();
    assert.deepEqual(calls, metricIds);
    gates.get(metricIds[10]!)!.reject(new TableauError('Already removed.', 404));
    gates.get(metricIds[11]!)!.resolve();
    const result = await operation;
    assert.equal(result.metricsDeleted, 10);
    assert.equal(result.definitionsDeleted, 0);
    assert.equal(result.failures.length, 2);
    const statusById = new Map(result.outcomes.map(outcome => [outcome.metricId, outcome.status]));
    assert.deepEqual(metricIds.map(id => statusById.get(id)), [
      'deleted', 'failed', 'deleted', 'deleted', 'deleted',
      'deleted', 'failed', 'deleted', 'deleted', 'deleted',
      'already_absent', 'deleted',
    ]);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await operation;
  }
});

test('reviewed metric deletion keeps throttling retries inside the current group', async () => {
  const retry = deferred();
  const retryStarted = deferred();
  const attempts = new Map<string, number>();
  const start = await reviewedDeletion();
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'DELETE');
    const url = new URL(String(input));
    assert.equal(url.origin, session.serverUrl);
    const id = url.pathname.slice('/api/-/pulse/metrics/'.length);
    assert.ok(metricIds.includes(id));
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    if (id === metricIds[0]) {
      if (attempt === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
      retryStarted.resolve();
      await retry.promise;
    }
    return new Response(null, { status: 204 });
  };
  const operation = start();
  try {
    await retryStarted.promise;
    assert.equal(attempts.get(metricIds[0]), 2, 'A provider-rejected DELETE must still retry.');
    assert.deepEqual([...attempts.keys()], metricIds.slice(0, 5));
    retry.resolve();
    const result = await operation;
    assert.equal(result.metricsDeleted, metricIds.length);
    assert.deepEqual(result.failures, []);
    assert.equal(attempts.size, metricIds.length);
    for (const id of metricIds.slice(1)) assert.equal(attempts.get(id), 1);
  } finally {
    retry.resolve();
    await operation;
  }
});

for (const [name, error, status] of [
  ['authentication expires', new TableauError('Expired.', 401, '', 'auth'), 'failed'],
  ['the connection fails', new TableauError('Connection lost.', 0, '', 'network'), 'unknown'],
  ['the provider outcome is uncertain', new TableauError('Unavailable.', 503), 'unknown'],
  ['an unexpected error occurs', new Error('Unknown outcome.'), 'unknown'],
] as const) {
  test(`reviewed metric deletion leaves later groups unsent when ${name}`, async () => {
    const active = deferred();
    const calls: string[] = [];
    const start = await reviewedDeletion(async (_owner, id) => {
      calls.push(id);
      await active.promise;
      if (id === metricIds[0]) throw error;
    });
    const operation = start();
    try {
      await setImmediate();
      assert.deepEqual(calls, metricIds.slice(0, 5));
      active.resolve();
      const result = await operation;
      assert.deepEqual(calls, metricIds.slice(0, 5));
      assert.equal(result.metricsDeleted, 4);
      assert.equal(result.failures.length, 1);
      const statusById = new Map(result.outcomes.map(outcome => [outcome.metricId, outcome.status]));
      assert.equal(statusById.get(metricIds[0]), status);
      for (const id of metricIds.slice(1, 5)) assert.equal(statusById.get(id), 'deleted');
      for (const id of metricIds.slice(5)) assert.equal(statusById.get(id), 'not_attempted');
    } finally {
      active.resolve();
      await operation;
    }
  });
}
