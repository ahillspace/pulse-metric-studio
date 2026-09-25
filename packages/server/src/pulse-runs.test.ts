import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-runs-composition-'));
const originalDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
const originalLogLevel = process.env.LOG_LEVEL;
const originalFetch = globalThis.fetch;
let core: typeof import('@pulse-metric-studio/core');
let buildApp: typeof import('./app.js').buildApp;
let registerPulseRoutes: typeof import('@pulse-metric-studio/pulse').registerPulseRoutes;

before(async () => {
  process.env.PULSE_METRIC_STUDIO_DATA_DIR = directory;
  process.env.LOG_LEVEL = 'silent';
  core = await import('@pulse-metric-studio/core');
  ({ buildApp } = await import('./app.js'));
  ({ registerPulseRoutes } = await import('@pulse-metric-studio/pulse'));
});
after(() => {
  globalThis.fetch = originalFetch;
  core?.clearSession();
  core?.closeDb();
  if (originalDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = originalDataDir;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('actual Pulse app publishes, reloads scoped history, and retries only failed run undo IDs', async () => {
  const a = core.saveConnection({ label: 'A', serverUrl: 'https://tableau.test', siteContentUrl: 'site', patName: 'test', patSecret: 'test', storageKind: 'encrypted' });
  const b = core.saveConnection({ label: 'B', serverUrl: 'https://tableau.test', siteContentUrl: 'site', patName: 'test-b', patSecret: 'test-b', storageKind: 'encrypted' });
  const connect = (connectionId: string) => core.setSession({ serverUrl: 'https://tableau.test', siteContentUrl: 'site', siteId: 'site-id', userId: 'user', token: 'test', apiVersion: '3.27' }, { connectionId, patSecret: 'test' });
  connect(a.id);
  let created = 0;
  let failDelete = true;
  const deleted: string[] = [];
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint === '/api/-/pulse/definitions' && init?.method === 'POST') {
      return Response.json({ definition: { metadata: { id: `definition-${++created}` } } });
    }
    const metric = endpoint.match(/\/definitions\/(definition-\d)\/metrics$/);
    if (metric) return Response.json({ metrics: [{ id: `metric-${metric[1]}` }] });
    const deletion = endpoint.match(/\/definitions\/(definition-\d)$/);
    if (deletion && init?.method === 'DELETE') {
      deleted.push(deletion[1]!);
      if (failDelete && deletion[1] === 'definition-2') return Response.json({ error: 'Forbidden' }, { status: 403 });
      return new Response(null, { status: 204 });
    }
    assert.fail(`Unexpected provider request: ${init?.method} ${endpoint}`);
  };
  let app = buildApp({ registerPulseRoutes });
  try {
    const payload = (name: string) => ({ name, specification: { datasource: { id: 'ds' }, basic_specification: { measure: { field: 'Sales' }, time_dimension: { field: 'Date' }, filters: [] } }, extension_options: { allowed_dimensions: [] } });
    const published = await app.inject({ method: 'POST', url: '/api/pulse/metrics/create', payload: { payloads: [payload('One'), payload('Two')], datasourceLuid: 'ds', datasourceName: 'Orders' } });
    assert.equal(published.statusCode, 200, published.body);
    const runId = published.json().runId;
    assert.equal(published.json().createdCount, 2);
    await app.close();
    core.closeDb();
    app = buildApp({ registerPulseRoutes });
    connect(b.id);
    const hidden = await app.inject('/api/pulse/runs?datasourceLuid=ds');
    assert.deepEqual(hidden.json().runs, []);
    assert.equal((await app.inject(`/api/pulse/runs/${runId}`)).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/pulse/runs/${runId}/undo` })).statusCode, 404);
    assert.deepEqual(deleted, []);
    connect(a.id);
    const history = await app.inject('/api/pulse/runs?datasourceLuid=ds');
    assert.equal(history.json().runs[0].runId, runId);
    assert.deepEqual(history.json().runs[0].results.map((item: any) => item.definitionId), ['definition-1', 'definition-2']);
    const partial = await app.inject({ method: 'POST', url: `/api/pulse/runs/${runId}/undo` });
    assert.equal(partial.statusCode, 200, partial.body);
    assert.deepEqual(partial.json().run.results.map((item: any) => item.undoStatus), ['deleted', 'failed']);
    assert.match(partial.json().run.results[1].undoError, /Forbidden/i);
    assert.equal(partial.json().run.results[1].error, undefined);
    await app.close();
    core.closeDb();
    app = buildApp({ registerPulseRoutes });
    connect(a.id);
    const recovered = await app.inject(`/api/pulse/runs/${runId}`);
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.match(recovered.json().results[1].undoError, /Forbidden/i);
    assert.equal(recovered.json().publishing, false);
    failDelete = false;
    const retried = await app.inject({ method: 'POST', url: `/api/pulse/runs/${runId}/undo` });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.deepEqual(deleted, ['definition-1', 'definition-2', 'definition-2']);
    assert.ok(retried.json().run.results.every((item: any) => item.undoStatus === 'deleted'));
    assert.ok(retried.json().run.results.every((item: any) => item.undoError === undefined));
    const completed = await app.inject({ method: 'POST', url: `/api/pulse/runs/${runId}/undo` });
    assert.deepEqual(completed.json().outcomes, []);
  } finally {
    await app.close();
  }
});
