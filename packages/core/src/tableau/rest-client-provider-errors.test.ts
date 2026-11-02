import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { getJson, postJson, TableauError, tableauProviderErrorInfo, type TableauSession } from './rest-client.js';
import { clearSession, setSession } from './session.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'fixture-secret-value', apiVersion: '3.27' };
beforeEach(() => setSession(session, { connectionId: 'connection', patSecret: '' }));
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });

test('REST errors retain the service validation header code without changing rejection classification', async () => {
  globalThis.fetch = async () => Response.json({ error: { summary: 'Definition conflict', detail: 'A matching definition exists.' } }, { status: 409, headers: { validation_code: '409902' } });
  await assert.rejects(postJson(session, '/api/-/pulse/definitions', {}), (error: unknown) => {
    assert.ok(error instanceof TableauError);
    assert.equal(error.status, 409);
    assert.equal(error.kind, 'http');
    assert.equal(error.providerCode, '409902');
    return true;
  });
});

test('REST JSON error codes remain available even without validation headers', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: '403004', summary: 'Forbidden', detail: 'Access was denied.' } }, { status: 403 });
  await assert.rejects(getJson(session, '/api/3.27/sites/site/groups'), (error: unknown) => error instanceof TableauError && error.providerCode === '403004' && error.kind === 'http');
});

test('a structured JSON error string remains a bounded sanitized human explanation', async () => {
  globalThis.fetch = async () => Response.json({ error: `Metric configuration conflict. token=${session.token}`, unrelated: 'must not be retained' }, { status: 409 });
  await assert.rejects(postJson(session, '/api/-/pulse/definitions', {}), (error: unknown) => {
    assert.ok(error instanceof TableauError);
    const info = tableauProviderErrorInfo(error);
    assert.match(info.summary!, /Metric configuration conflict.*redacted/);
    assert.doesNotMatch(JSON.stringify(info), /fixture-secret-value|must not be retained/);
    return true;
  });
});

test('human fields are extracted before a large structured error is truncated to its raw snippet', async () => {
  globalThis.fetch = async () => Response.json({ padding: 'x'.repeat(20000), error: { code: '409902', summary: 'Definition conflict', detail: 'A matching definition exists.' } }, { status: 409 });
  await assert.rejects(postJson(session, '/api/-/pulse/definitions', {}), (error: unknown) => {
    assert.ok(error instanceof TableauError);
    assert.ok(error.bodySnippet.length <= 800);
    assert.deepEqual(tableauProviderErrorInfo(error), { providerCode: '409902', summary: 'Definition conflict', detail: 'A matching definition exists.' });
    return true;
  });
});

test('XML details decode entities before redacting credential fields and the actual request token', async () => {
  const encoded = session.token.replaceAll('-', '&#45;');
  globalThis.fetch = async () => new Response(`<tsResponse><error code="403004"><summary>Forbidden</summary><detail>Token ${encoded}; authorization&#58; Bearer hidden-token</detail></error></tsResponse>`, { status: 403 });
  await assert.rejects(postJson(session, '/api/3.27/sites/site/groups', {}), (error: unknown) => {
    assert.ok(error instanceof TableauError);
    const info = tableauProviderErrorInfo(error);
    assert.equal(info.providerCode, '403004');
    assert.match(info.detail!, /\[redacted\]/);
    assert.doesNotMatch(info.detail!, /fixture-secret-value|hidden-token/);
    return true;
  });
});

for (const body of ['not structured', '{broken json', '<error><summary>broken', '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///missing">]><error><summary>&secret;</summary></error>']) {
  test('untrusted malformed or unstructured error bodies have a safe bounded fallback', async () => {
    globalThis.fetch = async () => new Response(body, { status: 400 });
    await assert.rejects(postJson(session, '/api/-/pulse/definitions', {}), (error: unknown) => error instanceof TableauError && Object.keys(tableauProviderErrorInfo(error)).length === 0);
  });
}
