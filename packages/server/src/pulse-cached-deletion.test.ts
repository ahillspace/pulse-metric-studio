import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearSession, closeDb, config, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { registerPulseRoutes } from '@pulse-metric-studio/pulse';
import { buildApp } from './app.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-cached-deletion-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
config.logLevel = 'silent';
const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://tableau.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'test-only', apiVersion: '3.27' };
const context = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'ds' };
type ProviderRequest = { method: string; pathname: string; search: string };

let principal = 0;
beforeEach(() => {
  session.userId = `user-${++principal}`;
  setSession({ ...session }, { connectionId: context.connectionId, patSecret: '' });
});
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

function provider(options: { partial?: boolean; deleteResponse?: (pathname: string) => Response | undefined } = {}) {
  const requests: ProviderRequest[] = [];
  const deletedDefinitions = new Set<string>();
  const deletedMetrics = new Set<string>();
  let externallyChanged = false;
  const definitions = [
    { metadata: { id: 'a', name: 'Revenue' }, specification: { datasource: { id: 'ds' } } },
    { metadata: { id: 'other', name: 'Other datasource' }, specification: { datasource: { id: 'other-ds' } } },
    { metadata: { id: 'b', name: 'Profit' }, specification: { datasource: { id: 'ds' } } },
  ];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, pathname: url.pathname, search: url.search });
    assert.equal(url.origin, session.serverUrl, 'the test never reaches a live service');
    if (method === 'DELETE') {
      const response = options.deleteResponse?.(url.pathname);
      if (response) return response;
      const definitionId = /^\/api\/-\/pulse\/definitions\/([^/]+)$/.exec(url.pathname)?.[1];
      const metricId = /^\/api\/-\/pulse\/metrics\/([^/]+)$/.exec(url.pathname)?.[1];
      if (definitionId) deletedDefinitions.add(definitionId);
      else if (metricId) deletedMetrics.add(metricId);
      else assert.fail(`Unexpected DELETE ${url.pathname}`);
      return new Response(null, { status: 204 });
    }
    assert.equal(method, 'GET');
    if (url.pathname === '/api/-/pulse/definitions') {
      const page = url.searchParams.get('page_token');
      const entries = (page ? definitions.slice(2) : definitions.slice(0, 2)).filter(definition => !deletedDefinitions.has(definition.metadata.id));
      return Response.json({ definitions: entries, ...(page ? {} : { next_page_token: 'last' }) });
    }
    const definitionId = /^\/api\/-\/pulse\/definitions\/([^/]+)\/metrics$/.exec(url.pathname)?.[1];
    if (definitionId) {
      assert.notEqual(definitionId, 'other', 'datasource filtering precedes metric enumeration');
      const ids = definitionId === 'a' ? ['a-default', 'a-variant', ...(externallyChanged ? ['a-later'] : [])] : ['b-default', 'b-variant'];
      return Response.json({ metrics: ids.filter(id => !deletedMetrics.has(id)).map(id => ({ id, is_default: id.endsWith('-default') })) });
    }
    const metricId = /^\/api\/-\/pulse\/metrics\/([^/]+)$/.exec(url.pathname)?.[1];
    if (metricId) {
      assert.ok(/^[ab]-/.test(metricId), 'datasource filtering precedes exact metric reads');
      if (options.partial && metricId === 'a-variant') return Response.json({ error: 'unavailable' }, { status: 403 });
      return Response.json({ metric: { id: metricId, definition_id: metricId[0], is_default: metricId.endsWith('-default'), specification: { measurement_period: {}, filters: [], comparison: {} } } });
    }
    if (url.pathname === '/api/-/pulse/subscriptions:batchGetMetricFollowerCounts') {
      const ids = url.searchParams.get('metric_ids')!.split(',');
      assert.ok(ids.every(id => /^[ab]-/.test(id)), 'follower counts only enrich the selected datasource');
      return Response.json({ counts: ids.map(id => ({ metric_id: id, count: 3 })) });
    }
    if (url.pathname === '/api/-/pulse/subscriptions') {
      const metricId = url.searchParams.get('metric_id');
      if (metricId) assert.ok(/^[ab]-/.test(metricId), 'targeted subscriptions only enrich the selected datasource');
      assert.equal(url.searchParams.get('page_size'), '100');
      return Response.json({ subscriptions: [] });
    }
    assert.fail(`Unexpected provider request ${url}`);
  };
  return { requests, changeExternally: () => { externallyChanged = true; } };
}

async function inventory(server: ReturnType<typeof buildApp>) {
  const response = await server.inject('/api/pulse/existing-metrics?datasourceLuid=ds');
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('real deletion uses displayed inventory, patches confirmed targets, and refreshes only on explicit demand', async () => {
  const fake = provider();
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    assert.deepEqual(displayed.definitions.map((definition: { definitionId: string }) => definition.definitionId), ['a', 'b']);
    const initialReadCount = fake.requests.length;
    assert.equal(initialReadCount, 8, 'two definition pages, two metric lists, four exact metrics');
    const metricIds = ['a-default', 'a-variant', 'b-default', 'b-variant'];
    const counts = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds, snapshotId: displayed.snapshotId, detail: false } });
    assert.equal(counts.statusCode, 200, counts.body);
    assert.equal(fake.requests.length - initialReadCount, 1, 'the initial summary reads one follower-count batch');
    const beforeDetails = fake.requests.length;
    const detailPayload = { metricIds, snapshotId: displayed.snapshotId, selectedGroupId: 'group', detail: true };
    const followState = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: detailPayload });
    assert.equal(followState.statusCode, 200, followState.body);
    assert.equal(fake.requests.length - beforeDetails, 5, 'one site discovery page plus four targeted reads while negative site coverage is unqualified');
    assert.deepEqual(followState.json().followerCountsByMetricId, {}, 'details do not repeat the initial counts');
    assert.ok(Object.values(followState.json().availabilityByMetricId).every(value => (value as { followerCountStatus: string }).followerCountStatus === 'not_requested'));
    const beforeRepeatedDetails = fake.requests.length;
    const repeated = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: detailPayload });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(fake.requests.length, beforeRepeatedDetails, 'the owned view retains subscription coverage');
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: ['a-default', 'a-variant', 'b-variant'] };
    const beforePreview = fake.requests.length;
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(fake.requests.length - beforePreview, 0, 'deletion preview must make zero Tableau requests');
    assert.equal(typeof displayed.snapshotId, 'string');
    assert.equal(preview.json().snapshotId, displayed.snapshotId);
    fake.changeExternally();
    const beforeDelete = fake.requests.length;
    const result = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(fake.requests.slice(beforeDelete).map(({ method, pathname }) => ({ method, pathname })), [
      { method: 'DELETE', pathname: '/api/-/pulse/definitions/a' },
      { method: 'DELETE', pathname: '/api/-/pulse/metrics/b-variant' },
    ]);
    const patch = result.json().inventoryPatch;
    assert.deepEqual(patch.removedDefinitionIds, ['a']);
    assert.deepEqual(patch.removedMetricIds, ['b-variant']);
    assert.notEqual(patch.snapshotId, displayed.snapshotId);
    const originalReview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(originalReview.statusCode, 200, originalReview.body);
    assert.equal(originalReview.json().previewFingerprint, preview.json().previewFingerprint, 'the original reviewed snapshot stays immutable');
    const removedReview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { ...selection, snapshotId: patch.snapshotId } });
    assert.equal(removedReview.statusCode, 409, removedReview.body);
    assert.equal(fake.requests.length, beforeDelete + 2, 'patch and snapshot review add no provider reads');
    const beforeRefresh = fake.requests.length;
    const refreshed = await inventory(server);
    assert.deepEqual(refreshed.definitions.map((definition: { definitionId: string }) => definition.definitionId), ['b']);
    assert.equal(fake.requests.length - beforeRefresh, 4, 'one fresh inventory: two pages, one metric list, one remaining exact metric');
  } finally { await server.close(); }
});

test('cached execution retains confirmed deletion when a later variant fails', async () => {
  const fake = provider({ deleteResponse: pathname => pathname.endsWith('/metrics/b-variant') ? Response.json({ error: 'forbidden' }, { status: 403 }) : undefined });
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: ['b-variant'] };
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    const beforeExecution = fake.requests.length;
    const response = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().definitionsDeleted, 1);
    assert.equal(response.json().metricsDeleted, 0);
    assert.deepEqual(response.json().outcomes.map(({ definitionId, metricId, status }: { definitionId?: string; metricId?: string; status: string }) => [definitionId ?? metricId, status]), [['a', 'deleted'], ['b-variant', 'failed']]);
    assert.deepEqual(fake.requests.slice(beforeExecution).map(request => request.method), ['DELETE', 'DELETE']);
  } finally { await server.close(); }
});

test('one immutable displayed snapshot supports multiple deletion batches before a single final refresh', async () => {
  const fake = provider();
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    const beforeReview = fake.requests.length;
    const batches = [];
    for (const definitionId of ['a', 'b']) {
      const selection = { context, snapshotId: displayed.snapshotId, definitionIds: [definitionId], metricIds: [] };
      const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
      assert.equal(preview.statusCode, 200, preview.body);
      batches.push({ ...selection, previewFingerprint: preview.json().previewFingerprint });
    }
    assert.equal(fake.requests.length, beforeReview);
    for (const payload of batches) {
      const response = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().definitionsDeleted, 1);
    }
    assert.deepEqual(fake.requests.slice(beforeReview).map(({ method, pathname }) => ({ method, pathname })), [
      { method: 'DELETE', pathname: '/api/-/pulse/definitions/a' },
      { method: 'DELETE', pathname: '/api/-/pulse/definitions/b' },
    ]);
    const beforeRefresh = fake.requests.length;
    const refreshed = await inventory(server);
    assert.deepEqual(refreshed.definitions, []);
    assert.equal(fake.requests.length - beforeRefresh, 2, 'one final two-page inventory without deleted-resource enrichment');
  } finally { await server.close(); }
});

test('uncertain cached execution stops remaining deletions without read revalidation', async () => {
  const fake = provider({ deleteResponse: pathname => pathname.endsWith('/definitions/a') ? Response.json({ error: 'interrupted' }, { status: 503 }) : undefined });
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: ['b-variant'] };
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    const beforeExecution = fake.requests.length;
    const response = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().outcomes.map(({ definitionId, metricId, status }: { definitionId?: string; metricId?: string; status: string }) => [definitionId ?? metricId, status]), [['a', 'unknown'], ['b-variant', 'not_attempted']]);
    assert.deepEqual(fake.requests.slice(beforeExecution).map(({ method, pathname }) => ({ method, pathname })), [{ method: 'DELETE', pathname: '/api/-/pulse/definitions/a' }]);
  } finally { await server.close(); }
});

test('cached deletion validates context, snapshot identity, selection and fingerprints without provider lookups', async () => {
  const fake = provider();
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: [] };
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    const beforeValidation = fake.requests.length;
    for (const change of [
      { context: { ...context, connectionId: 'other-connection' } },
      { context: { ...context, serverUrl: 'https://other.example.test' } },
      { context: { ...context, siteId: 'other-site' } },
      { context: { ...context, datasourceLuid: 'other-ds' } },
      { snapshotId: 'missing-snapshot' },
    ]) {
      const response = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { ...selection, ...change } });
      assert.equal(response.statusCode, 409, response.body);
    }
    const missing = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { context, definitionIds: ['a'], metricIds: [] } });
    assert.equal(missing.statusCode, 400, missing.body);
    const expired = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { ...selection, snapshotId: 'missing-snapshot' } });
    assert.match(expired.json().message, /refresh/i);
    const tamperedFingerprint = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: 'tampered' } });
    assert.equal(tamperedFingerprint.statusCode, 409, tamperedFingerprint.body);
    const tamperedSelection = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, definitionIds: ['b'], previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(tamperedSelection.statusCode, 409, tamperedSelection.body);
    const defaultMetric = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { ...selection, definitionIds: [], metricIds: ['a-default'] } });
    assert.equal(defaultMetric.statusCode, 409, defaultMetric.body);
    assert.equal(defaultMetric.json().code, 'delete_default_metric');
    assert.equal(fake.requests.length, beforeValidation, 'invalid cached operations never read or mutate Tableau');
  } finally { await server.close(); }
});

test('snapshots cannot be reused by a replacement connection, principal or session', async () => {
  const fake = provider();
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: [] };
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    const beforeReplacement = fake.requests.length;
    for (const replacement of [
      { session: { ...session }, connectionId: context.connectionId },
      { session: { ...session, userId: 'different-principal' }, connectionId: context.connectionId },
      { session: { ...session }, connectionId: 'other-connection' },
    ]) {
      setSession(replacement.session, { connectionId: replacement.connectionId, patSecret: '' });
      const response = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
      assert.equal(response.statusCode, 409, response.body);
    }
    clearSession();
    const disconnected = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(disconnected.statusCode, 401, disconnected.body);
    assert.equal(fake.requests.length, beforeReplacement);
  } finally { await server.close(); }
});

test('partial cached definitions require explicit acknowledgement and never authorize unknown IDs', async () => {
  const fake = provider({ partial: true });
  const server = buildApp({ registerPulseRoutes });
  try {
    const displayed = await inventory(server);
    assert.equal(displayed.definitions[0].inventoryStatus, 'partial');
    const selection = { context, snapshotId: displayed.snapshotId, definitionIds: ['a'], metricIds: [] };
    const beforeReview = fake.requests.length;
    const blocked = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json().code, 'delete_inventory_incomplete');
    const override = { ...selection, allowIncompleteInventory: true };
    const preview = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: override });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().targets[0].inventoryComplete, false);
    assert.ok(preview.json().warnings.some((warning: string) => /could not list every metric/i.test(warning)));
    for (const unknownSelection of [
      { definitionIds: ['other'], metricIds: [] },
      { definitionIds: ['unknown'], metricIds: [] },
      { definitionIds: [], metricIds: ['other-metric'] },
      { definitionIds: [], metricIds: ['a-variant'] },
    ]) {
      const rejected = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { ...override, ...unknownSelection } });
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
    assert.equal(fake.requests.length, beforeReview, 'partial review and rejected override do not discover more resources');
    const result = await server.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...override, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(fake.requests.slice(beforeReview).map(({ method, pathname }) => ({ method, pathname })), [{ method: 'DELETE', pathname: '/api/-/pulse/definitions/a' }]);
  } finally { await server.close(); }
});
