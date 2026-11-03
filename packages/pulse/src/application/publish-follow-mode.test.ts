import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { captureTableauUserAccess, clearSession, closeDb, config, getDb, registerTableauRoutes, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { defaultPulseMetric, emptyPulseDocument, type DatasourceCatalog } from '@pulse-metric-studio/shared';
import { registerPulseRoutes } from '../pulse/routes.js';

const originalFetch = globalThis.fetch;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-publish-follow-mode-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'publisher', userName: 'Fixture Publisher', token: 'fixture-token', apiVersion: '3.27' };
const context = { connectionId: 'connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource' };
const field = (id: string, role: 'MEASURE' | 'DIMENSION', dataType: string) => ({ id, name: id, label: id, caption: id, role, dataType, table: null, defaultAggregation: null, formula: null, requiresUserAgg: false });
const catalog: DatasourceCatalog = { datasourceLuid: 'datasource', datasourceName: 'Orders', measures: [field('Sales', 'MEASURE', 'REAL')], dimensions: [field('Region', 'DIMENSION', 'STRING')], timeDimensions: [{ ...field('Date', 'DIMENSION', 'DATE'), timeType: 'DATE' }], excluded: [], parameters: [], source: 'vds', warnings: [] };
beforeEach(() => setSession(session, { connectionId: 'connection', patSecret: '' }));
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

async function fixture(mode: 'none' | 'self' | 'group', access: 'allowed' | 'denied' | 'unknown' | 'actual' = 'allowed', owner = session, itemCount = 1) {
  const calls = { writes: 0, group: 0, currentUser: 0, access: 0 };
  const bodies: Array<{ metric_id: string; followers: unknown[] }> = [];
  const actualContext = { ...context, serverUrl: owner.serverUrl, datasourceLuid: `datasource-${crypto.randomUUID()}` };
  const names = ['Sales', 'Profit', 'Orders'].slice(0, itemCount);
  const catalogForDraft = { ...catalog, datasourceLuid: actualContext.datasourceLuid, measures: names.map((name) => field(name, 'MEASURE', 'REAL')) };
  let definitions = 0;
  let beforeCatalog: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'POST');
    calls.writes++;
    if (String(input).endsWith('/definitions')) { definitions++; return Response.json({ definition: { metadata: { id: itemCount === 1 ? 'created-definition' : `created-definition-${definitions}` } } }); }
    assert.ok(String(input).endsWith('/subscriptions:batchCreate'));
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) });
  };
  const app = Fastify();
  registerPulseRoutes(app, { catalog: async () => { await beforeCatalog?.(); return catalogForDraft; }, publish: {
    resolve: async (_session, definitionId) => definitionId.replace('created-definition', 'confirmed-metric'),
    ensureGroup: async () => { calls.group++; return { id: 'group', name: 'Audience', existedBefore: false }; },
    addMember: async () => { calls.group++; }, currentUser: async () => { calls.currentUser++; return 'unexpected-user'; },
    ...(access === 'actual' ? {} : { groupCreationAccess: () => { calls.access++; return { state: access, reasonCode: `fixture_${access}`, message: `Group creation is ${access}.` }; } }),
  } });
  const document = { ...emptyPulseDocument(), followMode: mode };
  for (const name of names) document.metrics[name] = defaultPulseMetric(catalogForDraft, name)!;
  document.slicers.Region = { active: true, fieldId: 'Region', fieldLabel: 'Region' };
  document.digestAudience = 'Audience';
  const created = await app.inject({ method: 'POST', url: '/api/pulse/drafts', payload: { context: actualContext, datasourceName: 'Orders', document } });
  assert.equal(created.statusCode, 200, created.body);
  const draft = created.json();
  const preview = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish-preview`, payload: { expectedRevision: draft.revision } });
  assert.equal(preview.statusCode, 200, preview.body);
  const request = { commandId: crypto.randomUUID(), expectedRevision: draft.revision, previewFingerprint: preview.json().previewFingerprint };
  return { app, draft, plan: preview.json(), request, calls, bodies, beforeCatalog: (hook: () => Promise<void>) => { beforeCatalog = hook; }, publish: () => app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish`, payload: request }) };
}

for (const refreshed of ['denied', 'unknown', 'allowed'] as const) {
  test(`a same-owner capability refresh to ${refreshed} during publication catalog loading uses current access`, async () => {
    const owner = { ...session, serverUrl: 'https://fixture.online.tableau.com' };
    setSession(owner, { connectionId: 'connection', patSecret: '' });
    captureTableauUserAccess(owner, { user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } });
    const run = await fixture('group', 'actual', owner);
    let started!: () => void;
    let release!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { started = resolve; });
    const catalogRelease = new Promise<void>((resolve) => { release = resolve; });
    run.beforeCatalog(async () => { started(); await catalogRelease; });
    try {
      const pending = run.publish().then((response) => response);
      await catalogStarted;
      captureTableauUserAccess(owner, refreshed === 'unknown' ? null : { user: { id: owner.userId, siteRole: refreshed === 'allowed' ? 'SiteAdministratorCreator' : 'Creator' } });
      release();
      const response = await pending;
      assert.equal(response.statusCode, refreshed === 'allowed' ? 200 : refreshed === 'denied' ? 403 : 409, response.body);
      if (refreshed !== 'allowed') {
        assert.equal(response.json().code, 'tableau_group_creation_unavailable');
        assert.equal(run.calls.writes, 0);
        assert.equal(run.calls.group, 0);
        const preview = await run.app.inject({ method: 'POST', url: `/api/pulse/drafts/${run.draft.id}/publish-preview`, payload: { expectedRevision: run.draft.revision } });
        assert.equal(preview.json().followMode, 'group');
        assert.ok(preview.json().issues.some((issue: { field: string }) => issue.field === 'followMode'));
      } else {
        assert.equal(run.calls.writes, 2);
        assert.equal(response.json().follow.mode, 'group');
      }
    } finally { release(); await run.app.close(); }
  });
}

test('self publication follows captured publisher and persists receipt without any group work', async () => {
  const run = await fixture('self', 'denied');
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.equal(receipt.follow.mode, 'self');
    assert.deepEqual(receipt.follow.selfRecipient, { id: 'publisher', name: 'Fixture Publisher' });
    assert.deepEqual(run.plan.selfRecipient, receipt.follow.selfRecipient);
    assert.deepEqual(run.bodies, [{ metric_id: 'confirmed-metric', followers: [{ user_id: 'publisher' }] }]);
    assert.equal(run.calls.group, 0);
    assert.equal(run.calls.currentUser, 0);
    assert.equal(run.calls.access, 0);
    const read = await run.app.inject(`/api/pulse/receipts/${receipt.id}`);
    assert.deepEqual(read.json().follow, receipt.follow);
    await run.publish();
    assert.equal(run.calls.writes, 2);
  } finally { await run.app.close(); }
});

test('a delayed older allowed status cannot replace a newer denial and admit group publication', async () => {
  const owner = { ...session, serverUrl: 'https://fixture.online.tableau.com' };
  setSession(owner, { connectionId: 'connection', patSecret: '' });
  let reads = 0;
  let started!: () => void;
  let release!: (response: Response) => void;
  const oldReadStarted = new Promise<void>((resolve) => { started = resolve; });
  const status = Fastify();
  registerTableauRoutes(status, { fetchImpl: async (input) => {
    assert.ok(String(input).endsWith('/users/current'));
    reads++;
    if (reads === 2) { started(); return new Promise<Response>((resolve) => { release = resolve; }); }
    return Response.json({ user: { id: owner.userId, siteRole: reads === 1 ? 'SiteAdministratorCreator' : 'Creator' } });
  } });
  let run: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    assert.equal((await status.inject('/api/tableau/status')).json().session.groupCreation.state, 'allowed');
    run = await fixture('group', 'actual', owner);
    const oldAllowed = status.inject('/api/tableau/status').then((response) => response);
    await oldReadStarted;
    const latest = await status.inject('/api/tableau/status');
    assert.equal(latest.json().session.groupCreation.state, 'denied');
    release(Response.json({ user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } }));
    await oldAllowed;
    const publication = await run.publish();
    assert.equal(publication.statusCode, 403, publication.body);
    assert.equal(publication.json().code, 'tableau_group_creation_unavailable');
    assert.equal(run.calls.writes, 0);
    assert.equal(run.calls.group, 0);
    assert.equal(run.calls.currentUser, 0);
    assert.equal(run.calls.access, 0);
    assert.equal(reads, 3);
  } finally {
    release?.(Response.json({}));
    await run?.app.close();
    await status.close();
  }
});

for (const access of ['denied', 'unknown'] as const) {
  test(`${access} group access blocks publication before its first write`, async () => {
    const run = await fixture('group', access);
    try { const response = await run.publish(); assert.ok(response.statusCode >= 400, response.body); assert.equal(run.calls.writes, 0); assert.equal(run.calls.group, 0); }
    finally { await run.app.close(); }
  });
}

test('a new authenticated generation invalidates the reviewed self publication fingerprint', async () => {
  const run = await fixture('self');
  try {
    setSession({ ...session, userId: 'replacement' }, { connectionId: 'connection', patSecret: '' });
    const response = await run.publish();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(run.calls.writes, 0);
  } finally { await run.app.close(); }
});

test('a publication conflict retains descriptive provider detail and code through its receipt', async () => {
  const run = await fixture('none');
  globalThis.fetch = async () => Response.json({ error: { code: '409902', summary: 'Definition conflict', detail: 'A matching metric definition already exists.' } }, { status: 409, headers: { validation_code: '409902' } });
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.equal(receipt.items[0].creationStatus, 'unknown');
    assert.equal(receipt.items[0].diagnostic.status, 409);
    assert.equal(receipt.items[0].diagnostic.providerCode, '409902');
    assert.match(receipt.items[0].diagnostic.message, /matching metric definition already exists/i);
    assert.doesNotMatch(receipt.items[0].diagnostic.message, /POST \/api/);
    const persisted = await run.app.inject(`/api/pulse/receipts/${receipt.id}`);
    assert.deepEqual(persisted.json().items[0].diagnostic, receipt.items[0].diagnostic);
  } finally { await run.app.close(); }
});

for (const role of ['Creator', undefined]) {
  test(`the real capability helper blocks ${role ?? 'unverified'} group access before provider writes`, async () => {
    const owner = { ...session, serverUrl: 'https://fixture.online.tableau.com' };
    setSession(owner, { connectionId: 'connection', patSecret: '' });
    if (role) captureTableauUserAccess(owner, { user: { id: owner.userId, siteRole: role } });
    const run = await fixture('group', 'actual', owner);
    try {
      assert.equal(run.plan.followMode, 'group');
      assert.ok(run.plan.issues.some((issue: { field: string }) => issue.field === 'followMode'));
      const response = await run.publish();
      assert.equal(response.statusCode, role ? 403 : 409, response.body);
      assert.equal(response.json().code, 'tableau_group_creation_unavailable');
      assert.equal(run.calls.writes, 0);
      assert.equal(run.calls.group, 0);
    } finally { await run.app.close(); }
  });
}

test('the real capability helper retains an administrator group publication workflow', async () => {
  const owner = { ...session, serverUrl: 'https://fixture.online.tableau.com' };
  setSession(owner, { connectionId: 'connection', patSecret: '' });
  captureTableauUserAccess(owner, { user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } });
  const run = await fixture('group', 'actual', owner);
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().follow.mode, 'group');
    assert.equal(run.calls.group, 2);
    assert.deepEqual(run.bodies, [{ metric_id: 'confirmed-metric', followers: [{ group_id: 'group' }] }]);
  } finally { await run.app.close(); }
});

test('self subscriptions retain confirmed, definite authentication rejection and unsent outcomes', async () => {
  const run = await fixture('self', 'denied', session, 3);
  let creates = 0;
  let follows = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/definitions')) { creates++; return Response.json({ definition: { metadata: { id: `created-definition-${creates}` } } }); }
    follows++;
    const body = JSON.parse(String(init?.body));
    return follows === 1 ? Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) }) : Response.json({ error: { code: '401001', detail: 'Session ended.' } }, { status: 401 });
  };
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.deepEqual(receipt.follow.subscriptions.map((row: { status: string }) => row.status), ['created', 'failed', 'not_attempted']);
    assert.equal(receipt.createdCount, 3);
    assert.equal(follows, 2);
    assert.equal(run.calls.group, 0);
    const read = await run.app.inject(`/api/pulse/receipts/${receipt.id}`);
    assert.deepEqual(read.json().follow, receipt.follow);
    await run.publish();
    assert.equal(follows, 2);
  } finally { await run.app.close(); }
});

test('an unconfirmed self-follow response remains unknown and is never replayed', async () => {
  const run = await fixture('self');
  let writes = 0;
  globalThis.fetch = async (input) => {
    writes++;
    return String(input).endsWith('/definitions') ? Response.json({ definition: { metadata: { id: 'created-definition' } } }) : Response.json({});
  };
  try {
    const first = await run.publish();
    assert.equal(first.json().follow.subscriptions[0].status, 'unknown');
    assert.equal(first.json().follow.selfRecipient.id, 'publisher');
    await run.publish();
    assert.equal(writes, 2);
    assert.equal(run.calls.group, 0);
  } finally { await run.app.close(); }
});

test('a self-follow conflict then confirmation authentication failure remains unknown without sending later metrics', async () => {
  const run = await fixture('self', 'denied', session, 3);
  let creates = 0;
  let follows = 0;
  let confirmations = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/definitions')) { creates++; return Response.json({ definition: { metadata: { id: `created-definition-${creates}` } } }); }
    if (init?.method === 'POST') { follows++; return Response.json({ error: 'Conflict requires confirmation' }, { status: 409 }); }
    confirmations++;
    return Response.json({ error: 'The owning session ended.' }, { status: 401, headers: { validation_code: '401001' } });
  };
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.deepEqual(receipt.follow.subscriptions.map((row: { status: string }) => row.status), ['unknown', 'not_attempted', 'not_attempted']);
    assert.match(receipt.follow.subscriptions[0].error, /owning account.*401001/);
    assert.equal(follows, 1);
    assert.equal(confirmations, 1);
    assert.equal(run.calls.group, 0);
    const read = await run.app.inject(`/api/pulse/receipts/${receipt.id}`);
    assert.deepEqual(read.json().follow, receipt.follow);
    await run.publish();
    assert.equal(follows, 1);
  } finally { await run.app.close(); }
});

test('stored legacy group documents and follow receipts retain their original intent at persistence boundaries', async () => {
  const run = await fixture('group');
  try {
    const legacy = { ...run.draft.document, groupFollow: true, digestAudienceLocked: true };
    delete legacy.followMode;
    getDb().prepare('UPDATE pulse_workspaces SET document_json=? WHERE id=?').run(JSON.stringify(legacy), run.draft.id);
    const draft = (await run.app.inject(`/api/pulse/drafts/${run.draft.id}`)).json();
    assert.equal(draft.document.followMode, 'group');
    assert.equal(draft.document.digestAudience, 'Audience');
    assert.equal(draft.document.digestAudienceLocked, true);
    assert.equal(Object.hasOwn(draft.document, 'groupFollow'), false);
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    const oldFollow = { ...receipt.follow };
    delete oldFollow.mode;
    getDb().prepare('UPDATE pulse_publish_runs SET follow_receipt_json=? WHERE id=?').run(JSON.stringify(oldFollow), receipt.id);
    const read = (await run.app.inject(`/api/pulse/receipts/${receipt.id}`)).json();
    assert.equal(read.follow.mode, 'group');
    assert.equal(read.follow.requested, true);
    assert.equal(read.follow.group.id, 'group');
  } finally { await run.app.close(); }
});
