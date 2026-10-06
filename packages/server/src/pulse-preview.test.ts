import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, config, clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { buildApp } from './app.js';
import { registerPulseRoutes } from '@pulse-metric-studio/pulse';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-preview-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://tableau.test', siteContentUrl: 'site', siteId: 'site-id', userId: 'user', token: 'private-session-token', apiVersion: '3.29' };
const context = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'source' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const metric = { id: 'metric', definition_id: 'definition', site_id: session.siteId, specification: { measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' }, filters: [] } };
const definition = { metadata: { id: 'definition', name: 'Revenue' }, specification: { datasource: { id: 'source' } }, extension_options: {}, representation_options: {}, insights_options: {} };
const bundle = { bundle_response: { result: { insight_groups: [{ insights: [
  { result: { type: 'popc', score: 2, markup: '<span>Revenue grew</span>', facts: { value: 100 }, viz: { mark: 'line' } } },
  { result: { type: 'top-drivers', score: 3, markup: 'Retail grew fastest', facts: { change: 20 } } },
] }] } } };
beforeEach(() => { globalThis.fetch = originalFetch; setSession(session, { connectionId: context.connectionId, patSecret: 'test-pat' }); });
after(() => { globalThis.fetch = originalFetch; clearSession(); closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
function provider(overrides: Partial<Record<string, () => Response>> = {}) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get('X-Tableau-Auth'), session.token);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    const endpoint = url.replace(session.serverUrl, '');
    if (overrides[endpoint]) return overrides[endpoint]!();
    if (endpoint === '/api/-/pulse/metrics/metric') return Response.json({ metric });
    if (endpoint === '/api/-/pulse/definitions/definition') return Response.json({ definition });
    if (endpoint === '/api/-/pulse/insights/springboard') return Response.json(bundle, { status: 201 });
    if (endpoint === '/api/-/pulse/images/metricCard') return Response.json({ content: png }, { status: 201 });
    throw new Error(`Unexpected provider path ${endpoint}`);
  };
  return requests;
}
async function preview(payload: Record<string, unknown> = { context }) {
  const server = buildApp({ registerPulseRoutes });
  try { return await server.inject({ method: 'POST', url: '/api/pulse/metrics/metric/preview', payload }); }
  finally { await server.close(); }
}

test('real preview route checks ownership, renders through Tableau, and returns only the bounded card contract', async () => {
  const requests = provider();
  const result = await preview();
  assert.equal(result.statusCode, 200, result.body);
  const response = result.json();
  assert.deepEqual(Object.keys(response).sort(), ['definitionId', 'generatedAt', 'imageDataUrl', 'metricId', 'name']);
  assert.equal(response.imageDataUrl, `data:image/png;base64,${png}`);
  assert.doesNotMatch(result.body, /private-session-token|test-pat|<span>/);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'POST', 'POST']);
  assert.equal(requests[2]!.body.bundle_request.input.metadata.metric_id, 'metric');
  assert.equal(requests[3]!.body.input.metricMetadata.definitionName, 'Revenue');
  assert.equal(requests[3]!.body.input.insights.top.markup, 'Retail grew fastest');
});

test('preview requires active matching connection before any provider request', async () => {
  const requests = provider();
  assert.equal((await preview({ context: { ...context, siteId: 'other' } })).statusCode, 409);
  assert.equal((await preview({ context: { ...context, connectionId: 'other' } })).statusCode, 409);
  clearSession();
  assert.equal((await preview()).statusCode, 401);
  assert.equal(requests.length, 0);
});

test('preview rejects metric identity, site, and datasource mismatches before insight generation', async () => {
  for (const overrides of [
    { '/api/-/pulse/metrics/metric': () => Response.json({ metric: { ...metric, id: 'different' } }) },
    { '/api/-/pulse/metrics/metric': () => Response.json({ metric: { ...metric, site_id: 'different' } }) },
    { '/api/-/pulse/definitions/definition': () => Response.json({ definition: { ...definition, specification: { datasource: { id: 'different' } } } }) },
  ]) {
    const requests = provider(overrides);
    assert.equal((await preview()).statusCode, 409);
    assert.ok(requests.every(request => request.method === 'GET'));
  }
});

test('preview reports unsupported image API and failed insight generation without fabricated data', async () => {
  provider({ '/api/-/pulse/images/metricCard': () => Response.json({}, { status: 404 }) });
  const unsupported = await preview();
  assert.equal(unsupported.statusCode, 501);
  assert.equal(unsupported.json().code, 'pulse_preview_unsupported');
  const requests = provider({ '/api/-/pulse/insights/springboard': () => Response.json({ bundle_response: { error: { code: 'no_data' } } }, { status: 201 }) });
  const unavailable = await preview();
  assert.equal(unavailable.statusCode, 422);
  assert.equal(requests.length, 3);
});

test('preview bounds streamed provider data and rejects invalid image content', async () => {
  provider({ '/api/-/pulse/images/metricCard': () => Response.json({ content: Buffer.from('<svg/>').toString('base64') }, { status: 201 }) });
  assert.equal((await preview()).json().code, 'pulse_preview_invalid_response');
  provider({ '/api/-/pulse/insights/springboard': () => new Response(' '.repeat(4 * 1024 * 1024 + 1)) });
  assert.equal((await preview()).statusCode, 502);
  provider({ '/api/-/pulse/metrics/metric': () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }) });
  assert.equal((await preview()).statusCode, 502);
});

test('connection switching during insight fetch discards the old preview', async () => {
  const requests = provider({ '/api/-/pulse/insights/springboard': () => { clearSession(); return Response.json(bundle); } });
  const response = await preview();
  assert.equal(response.statusCode, 401);
  assert.equal(requests.length, 3);
});


test('preview validates requests and surfaces Tableau permission failures', async () => {
  const requests = provider();
  assert.equal((await preview({ context: {} })).statusCode, 400);
  assert.equal(requests.length, 0);
  provider({ '/api/-/pulse/metrics/metric': () => Response.json({}, { status: 403 }) });
  assert.equal((await preview()).statusCode, 403);
  provider({ '/api/-/pulse/metrics/metric': () => Response.json({}, { status: 401 }) });
  assert.equal((await preview()).statusCode, 401);
});
