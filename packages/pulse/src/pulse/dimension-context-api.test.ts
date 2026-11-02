import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { clearSession, invalidateFieldsCache, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { PulseDimensionalForkService } from './dimensional-fork-service.js';
import { registerPulseRoutes } from './routes.js';

test('dimension API fields, count, values and search share source and VDS context', async () => {
  const originalFetch = globalThis.fetch;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  invalidateFieldsCache();
  const counts = { metrics: 0, definition: 0, datasource: 0, metadata: 0, dataQueries: 0 };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/pulse/metrics/')) { counts.metrics++; return Response.json({ metric: { id: url.pathname.split('/').at(-1), definition_id: 'definition', specification: { filters: [] } } }); }
    if (url.pathname.includes('/pulse/definitions/')) { counts.definition++; return Response.json({ definition: { metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['Region'] } } }); }
    if (url.pathname.endsWith('/datasources/datasource')) { counts.datasource++; return Response.json({ datasource: { id: 'datasource', name: 'Orders' } }); }
    if (url.pathname.endsWith('/read-metadata')) { counts.metadata++; return Response.json({ data: [{ fieldName: 'Region', dataType: 'STRING', fieldRole: 'DIMENSION' }, { fieldName: 'Date', dataType: 'DATE', fieldRole: 'DIMENSION' }] }); }
    assert.ok(url.pathname.endsWith('/query-datasource'), url.pathname);
    counts.dataQueries++;
    const body = JSON.parse(String(init?.body));
    return Response.json({ data: body.query.fields[0].function === 'COUNTD' ? [[2]] : [['West'], ['East']] });
  };
  const app = Fastify();
  registerPulseRoutes(app, { dimensionalForkService: new PulseDimensionalForkService() });
  try {
    for (const [url, detail] of [['/api/pulse/dimensions', {}], ['/api/pulse/dimensions/count', { fieldId: 'Region' }], ['/api/pulse/dimensions/values', { fieldId: 'Region' }], ['/api/pulse/dimensions/values', { fieldId: 'Region', search: 'West' }]] as const) {
      const response = await app.inject({ method: 'POST', url, payload: { sourceMetricIds: ['metric-a', 'metric-b'], ...detail } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.deepEqual(counts, { metrics: 2, definition: 1, datasource: 1, metadata: 1, dataQueries: 3 });
  } finally { await app.close(); globalThis.fetch = originalFetch; clearSession(); invalidateFieldsCache(); }
});
