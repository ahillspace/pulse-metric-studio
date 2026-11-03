import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getFieldCatalog, getLoadedFieldCatalog, invalidateFieldsCache } from './vds-fields.js';
import { TableauError, type TableauSession } from './rest-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; invalidateFieldsCache(); });
const luid = '11111111-1111-1111-1111-111111111111';
function session(): TableauSession {
  return { serverUrl: 'https://fixture.example.test', siteContentUrl: 'fixture', siteId: 'fixture-site', userId: 'fixture-user', token: 'fixture-token-value', apiVersion: '3.27' };
}
function metadata() {
  return Response.json({ data: { publishedDatasources: [{ luid, name: 'Fixture', fieldsConnection: {
    totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { __typename: 'ColumnField', id: 'sales', name: 'Sales', dataType: 'REAL', role: 'MEASURE' },
      { __typename: 'ColumnField', id: 'date', name: 'Date', dataType: 'DATE', role: 'DIMENSION' },
    ],
  } }] } });
}

test('successful Metadata fallback retains bounded primary VDS denial/unavailability through cache without changing source or warnings', async () => {
  const owner = session();
  const calls: string[] = [];
  let recovered = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('metadata/graphql')) return metadata();
    if (url.endsWith('read-metadata')) return recovered
      ? Response.json({ data: [{ fieldName: 'Date', fieldCaption: 'Date', dataType: 'DATE', fieldRole: 'DIMENSION' }] })
      : Response.json({ error: { code: '403004', summary: 'VDS access denied', detail: `Read Data permission is required. token=${owner.token}` } }, { status: 403 });
    return Response.json({ error: { code: '503001', summary: 'VDS service unavailable', detail: 'Try again later.' } }, { status: 503 });
  };
  const first = await getFieldCatalog(owner, luid, 'Fixture');
  assert.equal(first.source, 'metadata');
  assert.equal(first.timeDimensions.length, 1);
  assert.deepEqual(first.vdsFailures?.map((failure) => [failure.operation, failure.status, failure.providerCode, failure.kind]), [
    ['read-metadata', 403, '403004', 'http'], ['describe-datasource', 503, '503001', 'http'],
  ]);
  assert.match(first.vdsFailures![0].message, /VDS access denied/);
  assert.match(first.vdsFailures![0].detail!, /Read Data permission/);
  assert.equal(JSON.stringify(first.vdsFailures).includes(owner.token), false);
  assert.ok(first.vdsFailures!.every((failure) => failure.message.length <= 500 && (failure.detail?.length ?? 0) <= 500));
  assert.equal(first.warnings.some((warning) => /VDS access denied|503001/.test(warning)), false);
  const retained = structuredClone(first.vdsFailures);
  first.vdsFailures![0].message = 'caller mutation';
  const cached = await getFieldCatalog(owner, luid, 'Fixture');
  assert.deepEqual(cached.vdsFailures, retained);
  assert.deepEqual(getLoadedFieldCatalog(owner, luid)?.vdsFailures, retained);
  assert.equal(calls.length, 3);
  recovered = true;
  const fresh = await getFieldCatalog(owner, luid, 'Fixture', { refresh: true });
  assert.equal(fresh.source, 'vds');
  assert.equal(fresh.vdsFailures, undefined);
});

test('network and malformed-empty VDS attempts remain distinct after successful Metadata fallback', async () => {
  const owner = session();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('metadata/graphql')) return metadata();
    if (url.endsWith('read-metadata')) throw new TypeError(`Fixture network failure ${owner.token}`);
    return Response.json({ fieldGroups: [] });
  };
  const result = await getFieldCatalog(owner, luid, 'Fixture');
  assert.equal(result.source, 'metadata');
  assert.deepEqual(result.vdsFailures?.map((failure) => failure.kind), ['network', 'invalid-response']);
  assert.equal(JSON.stringify(result.vdsFailures).includes(owner.token), false);
  invalidateFieldsCache();
  globalThis.fetch = async (input) => String(input).includes('metadata/graphql') ? metadata() : Response.json({ data: { malformed: true } });
  const malformed = await getFieldCatalog(owner, luid, 'Fixture');
  assert.equal(malformed.source, 'metadata');
  assert.equal(malformed.vdsFailures?.length, 2);
  assert.ok(malformed.vdsFailures?.every((failure) => failure.kind === 'invalid-response'));
});

test('authentication failure propagates instead of becoming successful fallback provenance', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: '401002', summary: 'Session expired' } }, { status: 401 }); };
  await assert.rejects(() => getFieldCatalog(session(), luid, 'Fixture'), (error: unknown) => error instanceof TableauError && error.kind === 'auth');
  assert.equal(calls, 1);
});
