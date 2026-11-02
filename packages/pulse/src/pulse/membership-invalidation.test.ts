import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { clearSession, closeDb, config, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { defaultPulseMetric, emptyPulseDocument, type DatasourceCatalog } from '@pulse-metric-studio/shared';
import { registerPulseRoutes } from './routes.js';
import { addUserToGroup, deleteGroup } from './groups.js';
import { clearSubscriptionCaches, listUserGroupIds } from '../application/subscriptions.js';

const originalFetch = globalThis.fetch;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-membership-invalidation-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
const context = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' };
beforeEach(() => { setSession(session, { connectionId: 'connection', patSecret: '' }); clearSubscriptionCaches(); });
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); clearSubscriptionCaches(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
const group = { id: 'digest-group', name: 'Audience' };

test('publication add-member invalidates primed membership before fresh relationship details', async () => {
  let joined = false;
  let memberships = 0;
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users/user/groups')) { memberships++; return Response.json({ groups: { group: joined ? [group] : [] } }); }
    if (url.pathname.endsWith('/groups/digest-group/users')) { writes++; joined = true; return new Response(null, { status: 201 }); }
    if (url.pathname.endsWith('subscriptions:batchCreate')) return Response.json({ subscriptions: [{ metric_id: 'new-metric', follower: { group_id: group.id } }] });
    if (url.pathname.endsWith('subscriptions:batchGetMetricFollowerCounts')) return Response.json({ follower_counts: [{ metric_id: url.searchParams.get('metric_ids'), follower_count: 1 }] });
    assert.ok(url.pathname.endsWith('/subscriptions'), url.pathname);
    return Response.json({ subscriptions: [{ follower: { group_id: group.id } }] });
  };
  const field = (id: string, role: 'MEASURE' | 'DIMENSION', dataType: string) => ({ id, name: id, label: id, caption: id, role, dataType, table: null, defaultAggregation: null, formula: null, requiresUserAgg: false });
  const catalog: DatasourceCatalog = { datasourceLuid: 'datasource', datasourceName: 'Orders', measures: [field('Sales', 'MEASURE', 'REAL')], dimensions: [field('Region', 'DIMENSION', 'STRING')], timeDimensions: [{ ...field('Date', 'DIMENSION', 'DATE'), timeType: 'DATE' }], excluded: [], parameters: [], source: 'vds', warnings: [] };
  const app = Fastify();
  registerPulseRoutes(app, { catalog: async () => catalog, publish: { catalog: async () => catalog, create: async () => ({ definitionId: 'new-definition', raw: {} }), resolve: async () => 'new-metric', ensureGroup: async () => ({ ...group, existedBefore: false }) } });
  const detail = () => app.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['new-metric'] } });
  try {
    assert.equal((await detail()).json().groupFollowsByMetricId['new-metric'], false);
    const document = emptyPulseDocument();
    document.metrics.Sales = defaultPulseMetric(catalog, 'Sales')!;
    document.groupFollow = true;
    document.slicers.Region = { active: true, fieldId: 'Region', fieldLabel: 'Region' };
    const created = await app.inject({ method: 'POST', url: '/api/pulse/drafts', payload: { context, datasourceName: 'Orders', document } });
    assert.equal(created.statusCode, 200, created.body);
    const draft = created.json();
    const preview = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish-preview`, payload: { expectedRevision: draft.revision } });
    assert.equal(preview.statusCode, 200, preview.body);
    const result = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish`, payload: { commandId: crypto.randomUUID(), expectedRevision: draft.revision, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().follow.membership.status, 'created');
    assert.equal(writes, 1);
    const state = (await detail()).json();
    assert.equal(state.groupFollowsByMetricId['new-metric'], true);
    assert.equal(state.availabilityByMetricId['new-metric'].relationshipStatus, 'available');
    await detail();
    assert.equal(memberships, 2);
  } finally { await app.close(); }
});

for (const uncertain of [false, true]) {
  test(`${uncertain ? 'uncertain' : 'confirmed'} group removal invalidates retained membership`, async () => {
    let joined = true;
    let memberships = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === 'DELETE') { joined = false; if (uncertain) throw new TypeError('fetch failed'); return new Response(null, { status: 204 }); }
      memberships++;
      return Response.json({ groups: { group: joined ? [group] : [] } });
    };
    const app = Fastify();
    registerPulseRoutes(app);
    try {
      assert.equal((await app.inject('/api/pulse/groups')).json().groups.length, 1);
      if (uncertain) await assert.rejects(deleteGroup(session, group.id));
      else await deleteGroup(session, group.id);
      assert.deepEqual((await app.inject('/api/pulse/groups')).json().groups, []);
      assert.equal(memberships, 2);
    } finally { await app.close(); }
  });
}

test('an uncertain add-member invalidates only the target user in the captured session', async () => {
  const reads = new Map<string, number>();
  let joined = false;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') { joined = true; throw new TypeError('fetch failed'); }
    const id = new URL(String(input)).pathname.split('/').at(-2)!;
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return Response.json({ groups: { group: joined && id === 'user' ? [group] : [] } });
  };
  await listUserGroupIds(session, 'user');
  await listUserGroupIds(session, 'other-user');
  await assert.rejects(addUserToGroup(session, group.id, 'user'));
  assert.deepEqual(await listUserGroupIds(session, 'user'), [group]);
  assert.deepEqual(await listUserGroupIds(session, 'other-user'), []);
  assert.equal(reads.get('user'), 2);
  assert.equal(reads.get('other-user'), 1);
});

test('a deferred pre-mutation membership read cannot replace later fresh membership', async () => {
  let release!: (response: Response) => void;
  let memberships = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Response(null, { status: 201 });
    memberships++;
    return memberships === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : Response.json({ groups: { group: [group] } });
  };
  const old = listUserGroupIds(session, 'user');
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  await addUserToGroup(session, group.id, 'user');
  const current = listUserGroupIds(session, 'user');
  release(Response.json({ groups: { group: [] } }));
  await old;
  assert.deepEqual(await current, [group]);
  assert.deepEqual(await listUserGroupIds(session, 'user'), [group]);
  assert.equal(memberships, 2);
});

test('an old-session membership write cannot invalidate a replacement principal cache', async () => {
  const owner = { ...session };
  setSession(owner, { connectionId: 'connection', patSecret: '' });
  let finish!: (response: Response) => void;
  let memberships = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { finish = resolve; });
    memberships++;
    return Response.json({ groups: { group: memberships === 1 ? [] : [group] } });
  };
  await listUserGroupIds(owner, 'user');
  const mutation = addUserToGroup(owner, group.id, 'user');
  while (!finish) await new Promise<void>((resolve) => setImmediate(resolve));
  owner.userId = 'replacement-user';
  setSession(owner, { connectionId: 'connection', patSecret: '' });
  assert.deepEqual(await listUserGroupIds(owner, owner.userId), [group]);
  finish(new Response(null, { status: 201 }));
  await mutation.catch((error) => assert.equal(error.kind, 'auth'));
  assert.deepEqual(await listUserGroupIds(owner, owner.userId), [group]);
  assert.equal(memberships, 2);
});

test('definitive membership rejection preserves ordinary shared cache evidence', async () => {
  let memberships = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Response(null, { status: 403 });
    memberships++;
    return Response.json({ groups: { group: [] } });
  };
  await Promise.all([listUserGroupIds(session, 'user'), listUserGroupIds(session, 'user')]);
  await assert.rejects(addUserToGroup(session, group.id, 'user'));
  await listUserGroupIds(session, 'user');
  assert.equal(memberships, 1);
});
