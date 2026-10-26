import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_MAX_RESPONSE_BYTES, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import { addUserToGroup, deleteGroup, ensureGroup } from './groups.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session: TableauSession = {
  serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site-id',
  userId: 'user-id', token: 'test-token', apiVersion: '3.27',
};

test('group transport preserves full name and escapes XML without changing the label', async () => {
  const name = 'pmStudio - Superstore Sales Cloud (CalcTEST) & "Revenue" - Sales <Europe> ' + 'Audience '.repeat(10);
  let body = '';
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      body = String(init.body);
      return new Response('<tsResponse><group id="created-group" /></tsResponse>', { status: 201 });
    }
    return Response.json(String(input).includes('/api/-/') ? { groups: [] } : { groups: { group: [] } });
  };
  const result = await ensureGroup(session, name);
  assert.equal(result.name, name);
  assert.equal(result.id, 'created-group');
  assert.equal(result.existedBefore, false);
  assert.ok(body.includes('(CalcTEST) &amp; &quot;Revenue&quot;'));
  assert.ok(body.includes('&lt;Europe&gt;'));
  assert.ok(body.includes('Audience '.repeat(10)));
});

test('group lookup reuses the exact full name instead of a shortened punctuation-free name', async () => {
  const name = 'pmStudio - Superstore Sales Cloud (CalcTEST) - delete me';
  globalThis.fetch = async (_input, init) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json({ groups: [{ id: 'existing-group', name }] });
  };
  assert.deepEqual(await ensureGroup(session, name), { id: 'existing-group', name, existedBefore: true });
});

test('XML group creation rejects oversized success bodies without repeating the mutation', async () => {
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      writes += 1;
      return new Response('<tsResponse><group id="created-group" /></tsResponse>', {
        status: 201, headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
      });
    }
    return Response.json(String(input).includes('/api/-/') ? { groups: [] } : { groups: { group: [] } });
  };
  await assert.rejects(ensureGroup(session, 'New group'), /exceeds the permitted size/);
  assert.equal(writes, 1);
});

test('XML group error diagnostics stay bounded and preserve HTTP failure classification', async () => {
  for (const operation of [() => addUserToGroup(session, 'group', 'user'), () => deleteGroup(session, 'group')]) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 403, headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
    });
    await assert.rejects(operation(), (error: unknown) => error instanceof TableauError && error.status === 403 && error.kind === 'http');
    assert.equal(cancelled, true);
  }
});
