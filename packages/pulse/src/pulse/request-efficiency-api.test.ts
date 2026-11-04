import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { clearSession, setSession, getFieldCatalog, invalidateFieldsCache, type TableauSession } from '@pulse-metric-studio/core';
import { registerPulseRoutes } from './routes.js';

test('warm Manager create and duplicate use only authoritative writes and immutable local patches', async () => {
  const originalFetch = globalThis.fetch;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  const calls: string[] = [];
  let writes = 0;
  const definition = { metadata: { id: 'definition', name: 'Sales' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['Region'] } };
  const metric = { id: 'source', definition_id: 'definition', is_default: false, specification: { filters: [] } };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [definition] });
    if (url.pathname.endsWith('/metrics:getOrCreate')) { writes++; return Response.json({ is_metric_created: writes === 1, metric: { id: 'destination' } }); }
    if (url.pathname.endsWith('/definitions/definition/metrics')) return Response.json({ metrics: [metric] });
    if (url.pathname.endsWith('/definitions/definition')) return Response.json({ definition });
    if (url.pathname.includes('/metrics/')) return Response.json({ metric: { ...metric, id: url.pathname.split('/').at(-1) } });
    throw new Error(`Unexpected provider call ${url}`);
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const inventoryResponse = await app.inject({ method: 'GET', url: '/api/pulse/existing-metrics?datasourceLuid=datasource&refresh=true' });
    assert.equal(inventoryResponse.statusCode, 200, inventoryResponse.body);
    let inventory = inventoryResponse.json();
    for (const expected of ['created', 'existing']) {
      calls.length = 0;
      const response = await app.inject({ method: 'POST', url: '/api/pulse/metrics/fork', payload: { version: 1, context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: 'site', datasourceLuid: 'datasource' }, snapshotId: inventory.snapshotId, sourceMetricIds: ['source'], timeframe: { key: 'LAST_30_DAYS' }, clauses: [] } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['metrics:getOrCreate']);
      const summary = response.json();
      assert.equal(summary.results[0].status, expected);
      assert.equal(summary.results[0].metric.isDefault, null);
      assert.equal(summary.inventoryPatch.upserts.length, 1);
      inventory = { ...inventory, snapshotId: summary.inventoryPatch.snapshotId };
    }
  } finally { await app.close(); globalThis.fetch = originalFetch; clearSession(); }
});

test('fresh 34-source inventory and warm catalog share dimensions and create with F plus D calls', async () => {
  const originalFetch = globalThis.fetch;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'bulk-user', token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' }); invalidateFieldsCache();
  const sourceMetricIds = Array.from({ length: 34 }, (_, index) => `source-${index}`);
  const definitions = Array.from({ length: 11 }, (_, index) => ({ metadata: { id: `definition-${index}` }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['Region'] } }));
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions });
    if (url.pathname.endsWith('/metrics:getOrCreate')) { const command = JSON.parse(String(init?.body)); return Response.json({ is_metric_created: true, metric: { id: `variant-${command.definition_id}`, definition_id: command.definition_id, is_default: false, specification: command.specification } }); }
    const definitionId = url.pathname.match(/definitions\/(definition-\d+)\/metrics$/)?.[1];
    if (definitionId) return Response.json({ metrics: sourceMetricIds.flatMap((id, index) => `definition-${index % 11}` === definitionId ? [{ id, definition_id: definitionId, is_default: false, specification: { filters: [] } }] : []) });
    if (url.pathname.endsWith('/datasources/datasource')) return Response.json({ datasource: { id: 'datasource', name: 'Orders' } });
    if (url.pathname.endsWith('/read-metadata')) return Response.json({ data: [{ fieldName: 'Region', dataType: 'STRING', fieldRole: 'DIMENSION' }, { fieldName: 'Date', dataType: 'DATE', fieldRole: 'DIMENSION' }] });
    if (url.pathname.endsWith('/query-datasource')) { const body = JSON.parse(String(init?.body)); return Response.json({ data: body.query.fields[0].function === 'COUNTD' ? [[1]] : [['West']] }); }
    throw new Error(`Unexpected provider read ${url}`);
  };
  const app = Fastify(); registerPulseRoutes(app);
  try {
    const inventory = (await app.inject({ method: 'GET', url: '/api/pulse/existing-metrics?datasourceLuid=datasource&refresh=true' })).json();
    await getFieldCatalog(session, 'datasource'); calls.length = 0;
    const sources = { sourceMetricIds, snapshotId: inventory.snapshotId };
    const fields = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload: sources }); assert.equal(fields.statusCode, 200, fields.body); assert.equal(calls.length, 0);
    const sourceContextId = fields.json().sourceContextId;
    for (let repeat = 0; repeat < 2; repeat++) for (const suffix of ['count', 'values']) { const response = await app.inject({ method: 'POST', url: `/api/pulse/dimensions/${suffix}`, payload: { ...sources, sourceContextId, fieldId: 'Region' } }); assert.equal(response.statusCode, 200, response.body); }
    assert.equal(calls.length, 2, 'Repeated identical count and values share their validated answer.'); calls.length = 0;
    const response = await app.inject({ method: 'POST', url: '/api/pulse/metrics/fork', payload: { version: 1, ...sources, sourceContextId, context: { connectionId: 'connection', serverUrl: session.serverUrl, siteId: 'site', datasourceLuid: 'datasource' }, clauses: [{ fieldId: 'Region', selection: { mode: 'VALUES', exclude: false, values: ['West', 'West'] } }] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().created, 11);
    assert.equal(calls.filter(path => path.endsWith('/query-datasource')).length, 1);
    assert.equal(calls.filter(path => path.endsWith('/metrics:getOrCreate')).length, 11);
    assert.equal(calls.length, 12);
  } finally { await app.close(); globalThis.fetch = originalFetch; clearSession(); invalidateFieldsCache(); }
});

for (const filtered of [false, true]) test(`expired inventory then a ${filtered ? 'filtered' : 'timeframe'} duplicate reuses fresh context across local patches`, async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = Date.now(); Date.now = () => now;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: `expired-${filtered}`, token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' }); invalidateFieldsCache();
  const calls: string[] = [];
  let writes = 0;
  const definition = { metadata: { id: 'definition', name: 'Sales' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['Region'] } };
  const metric = { id: 'source', definition_id: 'definition', is_default: false, specification: { filters: [] } };
  globalThis.fetch = async input => {
    const url = new URL(String(input)); calls.push(url.pathname.split('/').at(-1)!);
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: [definition] });
    if (url.pathname.endsWith('/metrics:getOrCreate')) return Response.json({ is_metric_created: writes++ === 0, metric: { id: 'destination', is_default: false } });
    if (url.pathname.endsWith('/definitions/definition/metrics')) return Response.json({ metrics: [metric] });
    if (url.pathname.endsWith('/definitions/definition')) return Response.json({ definition });
    if (url.pathname.endsWith('/metrics/source')) return Response.json({ metric });
    if (url.pathname.endsWith('/metrics/destination')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/datasources/datasource')) return Response.json({ datasource: { id: 'datasource', name: 'Orders' } });
    if (url.pathname.endsWith('/read-metadata')) return Response.json({ data: [{ fieldName: 'Region', dataType: 'STRING', fieldRole: 'DIMENSION' }, { fieldName: 'Date', dataType: 'DATE', fieldRole: 'DIMENSION' }] });
    if (url.pathname.endsWith('/query-datasource')) return Response.json({ data: [['West']] });
    throw new Error(`Unexpected provider call ${url}`);
  };
  const app = Fastify(); registerPulseRoutes(app);
  const owner = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: 'site', datasourceLuid: 'datasource' };
  try {
    let inventory = (await app.inject({ method: 'GET', url: '/api/pulse/existing-metrics?datasourceLuid=datasource&refresh=true' })).json();
    if (filtered) await getFieldCatalog(session, 'datasource');
    now += 61_000;
    let sourceContextId: string | undefined;
    const create = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/pulse/metrics/fork', payload: { version: 1, context: owner, snapshotId: inventory.snapshotId, sourceMetricIds: ['source'], ...(sourceContextId ? { sourceContextId } : {}), timeframe: { key: 'LAST_30_DAYS' }, clauses: filtered ? [{ fieldId: 'Region', selection: { mode: 'VALUES', exclude: false, values: ['West'] } }] : [] } });
      assert.equal(response.statusCode, 200, response.body);
      inventory = { ...inventory, snapshotId: response.json().inventoryPatch.snapshotId };
      return response.json();
    };
    calls.length = 0; await create();
    assert.deepEqual(calls, ['source', 'definition', ...(filtered ? ['query-datasource'] : []), 'metrics:getOrCreate']);
    now += 23_000;
    calls.length = 0; const duplicate = await create();
    assert.equal(duplicate.results[0].status, 'existing');
    assert.deepEqual(calls, [...(filtered ? ['query-datasource'] : []), 'metrics:getOrCreate']);
    if (filtered) {
      calls.length = 0;
      const dimensions = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload: { sourceMetricIds: ['source'], snapshotId: inventory.snapshotId } });
      assert.equal(dimensions.statusCode, 200, dimensions.body); assert.deepEqual(calls, []);
      sourceContextId = dimensions.json().sourceContextId;
    }
    const review = await app.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: { context: owner, snapshotId: inventory.snapshotId, metricIds: ['destination'], definitionIds: [], allowIncompleteInventory: false } });
    assert.equal(review.statusCode, 200, review.body);
    const deleted = await app.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { context: owner, snapshotId: inventory.snapshotId, metricIds: ['destination'], definitionIds: [], allowIncompleteInventory: false, previewFingerprint: review.json().previewFingerprint } });
    assert.equal(deleted.statusCode, 200, deleted.body);
    inventory = { ...inventory, snapshotId: deleted.json().inventoryPatch.snapshotId };
    calls.length = 0; await create();
    assert.deepEqual(calls, [...(filtered ? ['query-datasource'] : []), 'metrics:getOrCreate'], 'Deleting a destination preserves source context for the same retained view.');
    now += 38_000; calls.length = 0; await create();
    assert.deepEqual(calls, ['source', 'definition', ...(filtered ? ['query-datasource'] : []), 'metrics:getOrCreate'], 'Local patches never refresh the original source acquisition time.');
    // Capture a currently valid filter handle, then prove that a manual refresh prevents its reuse.
    if (filtered) {
      const dimensions = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload: { sourceMetricIds: ['source'], snapshotId: inventory.snapshotId } });
      sourceContextId = dimensions.json().sourceContextId;
    }
    (metric.specification as Record<string, unknown>).marker = 'after-refresh';
    inventory = (await app.inject({ method: 'GET', url: '/api/pulse/existing-metrics?datasourceLuid=datasource&refresh=true' })).json();
    calls.length = 0;
    const refreshed = await create();
    assert.equal(refreshed.results[0].requestedSpecification.marker, 'after-refresh');
    assert.deepEqual(calls, [...(filtered ? ['query-datasource'] : []), 'metrics:getOrCreate']);

  } finally { await app.close(); Date.now = originalNow; globalThis.fetch = originalFetch; clearSession(); invalidateFieldsCache(); }
});
