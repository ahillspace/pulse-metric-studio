import type { TableauSession } from '@pulse-metric-studio/core';
import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { listTableauGroups,listTableauUsers } from './pulse-client.js';

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

test('listTableauGroups lists the whole site via the plural endpoint (no single-group GET, no name filter)', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ groups: { group: [{ id: 'group-1', name: 'Sales' }, { id: 'group-2', name: 'Support' }] } });
  };
  const groups = await listTableauGroups(session);
  assert.deepEqual(groups, [{ id: 'group-1', name: 'Sales' }, { id: 'group-2', name: 'Support' }]);
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /\/api\/3\.27\/sites\/site-id\/groups\?/);
  assert.doesNotMatch(urls[0]!, /\/groups\/group-/);
  // REST API 3.27 rejects `name:has:` (400065), so no name filter is sent.
  assert.doesNotMatch(urls[0]!, /filter=name/);
});

test('listTableauGroups accepts the flat envelope and never sends a name:has filter', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ group: [{ id: 'group-9', name: 'Analytics' }] });
  };
  const groups = await listTableauGroups(session);
  assert.deepEqual(groups, [{ id: 'group-9', name: 'Analytics' }]);
  assert.doesNotMatch(urls[0]!, /filter=name/);
  assert.doesNotMatch(urls[0]!, /has%3A/);
});

test('listTableauUsers paginates through every full page, preferring fullName, with no page cap', async () => {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    call += 1;
    // Three full pages of 2, then a short page: the whole directory is returned.
    const users = call === 1
      ? [{ id: 'user-1', name: 'ada@example.test', fullName: 'Ada Lovelace' }, { id: 'user-2', name: 'grace@example.test' }]
      : call === 2
        ? [{ id: 'user-3', name: 'Cara' }, { id: 'user-4', name: 'Dana' }]
        : [{ id: 'user-5', name: 'Eve' }];
    return Response.json({ users: { user: users } });
  };
  const users = await listTableauUsers(session, { pageSize: 2 });
  assert.equal(users.length, 5);
  assert.deepEqual(users.slice(0, 2), [
    { id: 'user-1', name: 'Ada Lovelace' },
    { id: 'user-2', name: 'grace@example.test' },
  ]);
  // Every full page is fetched (no artificial cap).
  assert.equal(urls.length, 3);
  assert.match(urls[0]!, /pageSize=2&pageNumber=1/);
  assert.match(urls[2]!, /pageSize=2&pageNumber=3/);
  assert.doesNotMatch(urls[0]!, /filter=name/);
});

test('listTableauUsers accumulates full pages until a short page', async () => {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    call += 1;
    const users = call === 1
      ? [{ id: 'user-1', name: 'Ada' }, { id: 'user-2', name: 'Bob' }]
      : [{ id: 'user-3', name: 'Cara' }];
    return Response.json({ users: { user: users } });
  };
  const users = await listTableauUsers(session, { pageSize: 2 });
  assert.equal(users.length, 3);
  assert.equal(urls.length, 2);
  assert.doesNotMatch(urls[1]!, /filter=name/);
});

test('listTableauUsers returns the whole directory when it fits on the first page', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({
      pagination: { totalAvailable: '1' },
      users: { user: [{ id: 'user-1', name: 'ada@example.test', fullName: 'Ada Lovelace' }] },
    });
  };
  const users = await listTableauUsers(session, { pageSize: 100 });
  assert.deepEqual(users, [{ id: 'user-1', name: 'Ada Lovelace' }]);
  assert.equal(urls.length, 1);
  assert.doesNotMatch(urls[0]!, /filter=name/);
});
