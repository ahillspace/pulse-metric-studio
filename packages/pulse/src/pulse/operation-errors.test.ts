import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { clearSession, invalidateFieldsCache, setSession, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { executeDeletes } from '../application/delete-execution.js';
import { followTargets, unfollowTargets } from '../application/subscriptions.js';
import { ensureGroup } from './groups.js';
import { pulseOperationDiagnostic } from './operation-errors.js';
import { registerPulseRoutes } from './routes.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'fixture-secret-value', apiVersion: '3.27' };
beforeEach(() => { setSession(session, { connectionId: 'connection', patSecret: '' }); invalidateFieldsCache(); });
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); invalidateFieldsCache(); });

test('a header-only verified publish conflict is descriptive while unrelated conflicts and throttling remain distinct', () => {
  const known = pulseOperationDiagnostic(new TableauError('POST /api/-/pulse/definitions failed', 409, '', 'http', '409902'), 'publish');
  assert.match(known.message, /existing metric definition/);
  assert.equal(known.providerCode, '409902');
  const generic = pulseOperationDiagnostic(new TableauError('failed', 409), 'publish');
  assert.match(generic.message, /conflict/);
  assert.doesNotMatch(generic.message, /existing/);
  assert.match(pulseOperationDiagnostic(new TableauError('failed', 429), 'publish').message, /limiting requests/);
});

test('real deletion adapter retains provider explanation without extra reads or changing definite failure', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init!.method!);
    return new Response('<tsResponse><error code="403004"><summary>Forbidden</summary><detail>Delete permission is required.</detail></error></tsResponse>', { status: 403 });
  };
  const result = await executeDeletes(session, [{ definitionId: 'definition', metricIds: ['metric'], name: 'Fixture' }]);
  assert.deepEqual(methods, ['DELETE']);
  assert.equal(result.outcomes[0]!.status, 'failed');
  assert.match(result.outcomes[0]!.error!, /Delete permission.*403004.*HTTP 403/);
  assert.doesNotMatch(result.outcomes[0]!.error!, /DELETE \/api/);
});

test('real follow and unfollow adapters retain actionable provider errors and mutation certainty', async () => {
  const operations = [{ metricId: 'metric', target: { kind: 'USER' as const, id: 'user' } }];
  let removing = false;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    methods.push(init!.method!);
    if (init?.method === 'GET') return Response.json({ subscriptions: removing ? [{ id: 'subscription', follower: { user_id: 'user' } }] : [] });
    return Response.json({ error: { code: '403004', summary: 'Forbidden', detail: 'Subscription permission is required.' } }, { status: 403 });
  };
  const followed = await followTargets(session, { operations });
  assert.equal(followed[0]!.status, 'failed');
  assert.match(followed[0]!.error!, /Follow this metric.*Subscription permission.*403004/);
  removing = true;
  const removed = await unfollowTargets(session, { operations });
  assert.equal(removed[0]!.status, 'failed');
  assert.match(removed[0]!.error!, /Unfollow this metric.*Subscription permission.*403004/);
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'DELETE']);
});

test('group XML adapter captures decoded provider fields and header code before raw truncation', async () => {
  globalThis.fetch = async (_input, init) => init?.method === 'POST'
    ? new Response(`<tsResponse>${' '.repeat(1000)}<error><summary>Forbidden</summary><detail>Group permission is required. Token ${session.token.replaceAll('-', '&#45;')}</detail></error></tsResponse>`, { status: 403, headers: { validation_code: '403004' } })
    : Response.json({ groups: [] });
  await assert.rejects(ensureGroup(session, 'Fixture'), (error: unknown) => {
    const diagnostic = pulseOperationDiagnostic(error, 'group', [session.token]);
    assert.equal(diagnostic.providerCode, '403004');
    assert.match(diagnostic.message, /Group permission/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-secret-value/);
    return true;
  });
});

test('the deliberate dimension route explains retained VDS denial after successful Metadata fallback', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/pulse/metrics/')) return Response.json({ metric: { id: 'metric', definition_id: 'definition', specification: { filters: [] } } });
    if (url.pathname.includes('/pulse/definitions/')) return Response.json({ definition: { metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: ['Region'] } } });
    if (url.pathname.endsWith('/datasources/datasource')) return Response.json({ datasource: { id: 'datasource', name: 'Fixture' } });
    if (url.pathname.includes('metadata/graphql')) return Response.json({ data: { publishedDatasources: [{ luid: 'datasource', name: 'Fixture', fieldsConnection: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'ColumnField', id: 'region', name: 'Region', dataType: 'STRING', role: 'DIMENSION' }] } }] } });
    return Response.json({ error: { code: '403004', summary: 'VDS access denied', detail: 'API Access permission is required.' } }, { status: 403 });
  };
  const app = Fastify();
  registerPulseRoutes(app);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload: { sourceMetricIds: ['metric'] } });
    assert.equal(response.statusCode, 422, response.body);
    assert.match(response.json().message, /API Access.*403004.*HTTP 403/);
    assert.doesNotMatch(response.json().message, /administrator|POST \/api/i);
  } finally { await app.close(); }
});

for (const status of [403, 401]) {
  test(`the deliberate dimension route formats a direct provider ${status} without leaking its endpoint`, async () => {
    globalThis.fetch = async () => Response.json({ error: { code: `${status}004`, detail: 'Source metric access was rejected.' } }, { status });
    const app = Fastify();
    registerPulseRoutes(app);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload: { sourceMetricIds: ['metric'] } });
      assert.equal(response.statusCode, status === 401 ? 401 : 502, response.body);
      assert.match(response.json().message, new RegExp(`Load fields for this variant.*${status}004.*HTTP ${status}`));
      assert.doesNotMatch(response.json().message, /GET \/api/);
    } finally { await app.close(); }
  });
}
