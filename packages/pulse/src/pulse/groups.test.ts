import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import { ensureGroup } from './groups.js';

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
