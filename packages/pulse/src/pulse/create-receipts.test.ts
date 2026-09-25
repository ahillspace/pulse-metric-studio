import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, config, getDb, setSession, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { publishMetrics } from './create-service.js';
import { getRunReceipt, listRunReceipts, undoRunReceipt } from './run-history.js';
import { executeDeletes } from './manage-service.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-receipts-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
const session: TableauSession = { serverUrl: 'https://tableau.test', siteContentUrl: 'site', siteId: 'site-1', token: 'token', userId: 'user', apiVersion: '3.27' };
const payload = (name: string) => ({ name, specification: { datasource: { id: 'ds' }, basic_specification: { measure: { field: 'Sales' }, time_dimension: { field: 'Date' }, filters: [] } }, extension_options: { allowed_dimensions: [] } });
const input = (payloads: unknown[]) => ({ payloads, withGroupFollow: false, datasourceLuid: 'ds', datasourceName: 'Datasource' });

test('publish retains every attempted item and persists confirmed IDs before failed resolution', async () => {
  setSession(session, { connectionId: 'connection-1', patSecret: 'secret' });
  const run = await publishMetrics(session, 'connection-1', input([{ name: 'invalid-1' }, { name: 'invalid-2' }, payload('provider-fails'), payload('created')]), {
    createDefinition: async (_session, value) => {
      if ((value as any).name === 'provider-fails') throw new TableauError('Forbidden', 403);
      return { definitionId: 'definition-1', raw: {} };
    },
    resolveDefaultMetricId: async () => {
      const saved = getDb().prepare("SELECT * FROM run_metrics WHERE definition_id = 'definition-1'").get() as any;
      assert.equal(saved.creation_status, 'created');
      assert.equal(saved.resolution_status, 'pending');
      throw new TableauError('Authentication failed', 401, '', 'auth');
    },
  });
  assert.equal(run.results.length, 4);
  assert.equal(run.createdCount, 1);
  assert.equal(run.results[3]?.definitionId, 'definition-1');
  assert.equal(run.results[3]?.status, 'created');
  assert.equal(run.results[3]?.resolutionStatus, 'failed');
  const rows = getDb().prepare('SELECT * FROM run_metrics WHERE run_id = ? ORDER BY item_index').all(run.runId) as any[];
  assert.deepEqual(rows.map((row) => row.name), ['invalid-1', 'invalid-2', 'provider-fails', 'created']);
  assert.ok(rows.every((row) => JSON.parse(row.payload_json).name === row.name));
  closeDb();
  assert.equal(getRunReceipt(session, run.runId).results[3]?.definitionId, 'definition-1');
  assert.equal(listRunReceipts(session, 'ds')[0]?.runId, run.runId);
});

test('undo durably retains failures, retries only unresolved IDs and rejects a different owner', async () => {
  setSession(session, { connectionId: 'connection-1', patSecret: 'secret' });
  let index = 0;
  const run = await publishMetrics(session, 'connection-1', input([payload('a'), payload('b')]), {
    createDefinition: async () => ({ definitionId: `undo-${++index}`, raw: {} }),
    resolveDefaultMetricId: async () => { throw new Error('resolution unavailable'); },
  });
  const calls: string[] = [];
  let fail = true;
  const deletes = {
    deleteDefinition: async (_session: TableauSession, id: string) => {
      calls.push(id);
      if (fail && id === 'undo-2') throw new TableauError('Forbidden', 403);
    },
    deleteMetric: async () => assert.fail('definition undo must not delete individual metrics'),
  };
  const partial = await undoRunReceipt(session, run.runId, deletes);
  assert.deepEqual(partial.run.results.map((item) => item.undoStatus), ['deleted', 'failed']);
  assert.match(partial.run.results[1]!.error!, /resolution unavailable/);
  assert.match(partial.run.results[1]!.undoError!, /Forbidden/);
  assert.equal(partial.failures.length, 1);
  closeDb();
  fail = false;
  const retry = await undoRunReceipt(session, run.runId, deletes);
  assert.deepEqual(calls, ['undo-1', 'undo-2', 'undo-2']);
  assert.ok(retry.run.results.every((item) => item.undoStatus === 'deleted'));
  assert.ok(retry.run.results.every((item) => item.undoError === undefined));
  assert.ok(retry.run.results.every((item) => item.error?.includes('resolution unavailable')));
  assert.equal((await undoRunReceipt(session, run.runId, deletes)).outcomes.length, 0);
  const other = { ...session, siteId: 'other-site' };
  setSession(other, { connectionId: 'connection-1', patSecret: 'secret' });
  assert.deepEqual(listRunReceipts(other), []);
  await assert.rejects(undoRunReceipt(other, run.runId, deletes), /not found/);
  assert.deepEqual(calls, ['undo-1', 'undo-2', 'undo-2']);
});

test('missing response ID and ambiguous POST failures remain distinct persisted unknown outcomes', async () => {
  setSession(session, { connectionId: 'connection-1', patSecret: 'secret' });
  let index = 0;
  const run = await publishMetrics(session, 'connection-1', input([payload('no-id'), payload('timeout')]), {
    createDefinition: async () => { if (index++) throw new TableauError('timeout', 0, '', 'network'); return { definitionId: null, raw: {} }; },
    resolveDefaultMetricId: async () => assert.fail('no confirmed ID'),
  });
  assert.deepEqual(getRunReceipt(session, run.runId).results.map((item) => item.creationStatus), ['unknown', 'unknown']);
  assert.ok(run.results.every((item) => item.error));
});

test('delete outcomes account for all failures, expired authentication and already absent definitions', async () => {
  const entries = ['forbidden', 'expired', 'absent'].map((definitionId) => ({ definitionId, metricIds: [], name: definitionId }));
  const result = await executeDeletes(session, entries, {
    deleteDefinition: async (_session, id) => { throw new TableauError(id, id === 'absent' ? 404 : id === 'expired' ? 401 : 403, '', id === 'expired' ? 'auth' : 'http'); },
    deleteMetric: async () => assert.fail('definition only'),
  });
  assert.deepEqual(result.outcomes.map((item) => [item.definitionId, item.status]), [['forbidden', 'failed'], ['expired', 'failed'], ['absent', 'already_absent']]);
  assert.equal(result.failures.length, 2);
  assert.equal(result.definitionsDeleted, 1);
});

test('undo rejects a partially published run until optional resolution completes', async () => {
  setSession(session, { connectionId: 'connection-1', patSecret: 'secret' });
  let resume!: () => void;
  let started!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const publishing = publishMetrics(session, 'connection-1', input([payload('paused')]), {
    createDefinition: async () => ({ definitionId: 'paused-definition', raw: {} }),
    resolveDefaultMetricId: async () => { started(); await paused; return null; },
  });
  await reached;
  const run = listRunReceipts(session).find((candidate) => candidate.results.some((item) => item.definitionId === 'paused-definition'))!;
  assert.equal(run.publishing, true);
  try {
    await assert.rejects(undoRunReceipt(session, run.runId), (error: any) => error.statusCode === 409);
  } finally { resume(); }
  await publishing;
  assert.equal(getRunReceipt(session, run.runId).publishing, false);
  const undone = await undoRunReceipt(session, run.runId, { deleteDefinition: async () => {}, deleteMetric: async () => {} });
  assert.equal(undone.run.results[0]?.undoStatus, 'deleted');
});
