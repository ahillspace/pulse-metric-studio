import type { TableauSession } from '@pulse-metric-studio/core';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { listUserGroupIds } from '../application/subscriptions.js';

const originalFetch = globalThis.fetch;
const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('user-group inventory supports nested and flat provider envelopes', async () => {
  const responses = [
    { groups: { group: [{ id: 'group-1', name: 'Sales' }] } },
    { group: [{ id: 'group-2', name: 'Support' }] },
  ];
  for (const [index, response] of responses.entries()) {
    globalThis.fetch = async () => Response.json(response);
    assert.deepEqual(await listUserGroupIds(session, session.userId), [{
      id: `group-${index + 1}`,
      name: index === 0 ? 'Sales' : 'Support',
    }]);
  }
});

test('user-group inventory rejects unknown roots and malformed records', async () => {
  globalThis.fetch = async () => Response.json({ items: [] });
  await assert.rejects(
    () => listUserGroupIds(session, session.userId),
    /Unsupported Tableau user-groups response shape/,
  );

  globalThis.fetch = async () => Response.json({ group: [{ id: 'group-1' }] });
  await assert.rejects(
    () => listUserGroupIds(session, session.userId),
    /Unsupported Tableau user-groups record shape/,
  );
});
