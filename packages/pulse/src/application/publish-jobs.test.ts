import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { clearSession, closeDb, config, setSession, TABLEAU_MUTATION_BLOCK_PAUSE_MS, type TableauSession } from '@pulse-metric-studio/core';
import { defaultPulseMetric, emptyPulseDocument, type DatasourceCatalog, type PulseFollowMode } from '@pulse-metric-studio/shared';
import { batchCreateUserSubscriptions } from '../pulse/pulse-client.js';
import { registerPulseRoutes } from '../pulse/routes.js';
import type { PublishDependencies } from './publish.js';

const originalFetch = globalThis.fetch;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-publish-jobs-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

const NOT_SENT = 'Not sent: the publication stopped before this metric.';
const field = (id: string, role: 'MEASURE' | 'DIMENSION', dataType: string) => ({ id, name: id, label: id, caption: id, role, dataType, table: null, defaultAggregation: null, formula: null, requiresUserAgg: false });
const limited = (seconds = 1) => Response.json({ error: 'limited' }, { status: 429, headers: { 'Retry-After': String(seconds) } });
const created = (id: string) => Response.json({ definition: { metadata: { id } } });
const confirmed = (init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  return Response.json({ subscriptions: body.followers.map((follower: unknown) => ({ metric_id: body.metric_id, follower })) });
};

type Reply = { statusCode: number; body: string; json(): any };

/** Follows a job started by `start` until it answers with its final response. */
async function finish(app: ReturnType<typeof Fastify>, start: Reply): Promise<Reply> {
  let response = start;
  if (response.statusCode === 200 && response.json().job) response = await app.inject({ method: 'GET', url: `/api/pulse/jobs/${response.json().job.id}` });
  for (let polls = 0; response.statusCode === 202 && polls < 200; polls++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    response = await app.inject({ method: 'GET', url: `/api/pulse/jobs/${response.json().job.id}` });
  }
  return response;
}

/**
 * A reviewed draft of `count` metrics owned by its own Tableau user, so a
 * throttle one test provokes never holds another test's requests.
 */
async function fixture(mode: PulseFollowMode, count: number, publish: Partial<PublishDependencies> = {}) {
  const owner: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: `publisher-${crypto.randomUUID()}`, userName: 'Fixture Publisher', token: 'fixture-token', apiVersion: '3.27' };
  setSession(owner, { connectionId: 'connection', patSecret: '' });
  const datasourceLuid = `datasource-${crypto.randomUUID()}`;
  const names = Array.from({ length: count }, (_, index) => `Measure${index + 1}`);
  const catalog: DatasourceCatalog = { datasourceLuid, datasourceName: 'Orders', measures: names.map((name) => field(name, 'MEASURE', 'REAL')), dimensions: [field('Region', 'DIMENSION', 'STRING')], timeDimensions: [{ ...field('Date', 'DIMENSION', 'DATE'), timeType: 'DATE' }], excluded: [], parameters: [], source: 'vds', warnings: [] };
  const app = Fastify();
  registerPulseRoutes(app, { catalog: async () => catalog, publish: {
    resolve: async (_session, definitionId) => definitionId.replace('definition', 'metric'),
    groupCreationAccess: () => ({ state: 'allowed', reasonCode: 'fixture_allowed', message: 'Group creation is allowed.' }),
    ...publish,
  } });
  const document = { ...emptyPulseDocument(), followMode: mode };
  for (const name of names) document.metrics[name] = defaultPulseMetric(catalog, name)!;
  document.slicers.Region = { active: true, fieldId: 'Region', fieldLabel: 'Region' };
  document.digestAudience = 'Audience';
  const draft = (await app.inject({ method: 'POST', url: '/api/pulse/drafts', payload: { context: { connectionId: 'connection', serverUrl: owner.serverUrl, siteId: owner.siteId, datasourceLuid }, datasourceName: 'Orders', document } })).json();
  const preview = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish-preview`, payload: { expectedRevision: draft.revision } });
  assert.equal(preview.statusCode, 200, preview.body);
  const request = { commandId: crypto.randomUUID(), expectedRevision: draft.revision, previewFingerprint: preview.json().previewFingerprint };
  return {
    app, owner, request,
    publish: () => app.inject({ method: 'POST', url: `/api/pulse/drafts/${draft.id}/publish`, payload: request }),
    undo: () => app.inject({ method: 'POST', url: `/api/pulse/receipts/${request.commandId}/undo`, payload: {} }),
    deleteGroup: (groupId: string) => app.inject({ method: 'POST', url: `/api/pulse/receipts/${request.commandId}/delete-group`, payload: { groupId } }),
    cancel: (start: Reply) => app.inject({ method: 'POST', url: `/api/pulse/jobs/${start.json().job.id}/cancel` }),
    read: () => app.inject(`/api/pulse/receipts/${request.commandId}`),
  };
}

const isCreate = (input: unknown, init?: RequestInit) => init?.method === 'POST' && String(input).endsWith('/definitions');
const isSubscribe = (input: unknown) => String(input).endsWith('/subscriptions:batchCreate');

test('publication creates are paced in blocks, and the digest group joins the same pacing', async () => {
  const sent: number[] = [];
  let groupAt = 0;
  globalThis.fetch = async (input, init) => {
    assert.ok(isCreate(input, init), `Unexpected request ${String(input)}`);
    sent.push(Date.now());
    return created(`definition-${sent.length}`);
  };
  const run = await fixture('group', 5, {
    ensureGroup: async () => { groupAt = Date.now(); return { id: 'group', name: 'Audience', existedBefore: true }; },
    addMember: async () => {}, subscribe: async (_session, items) => items.map((item) => ({ ...item, targetId: item.groupId, ok: true, alreadyExists: false })),
  });
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().items.map((item: { creationStatus: string }) => item.creationStatus), Array(5).fill('created'));
    assert.ok(sent[4]! - sent[0]! < TABLEAU_MUTATION_BLOCK_PAUSE_MS, 'The first block goes out without a pause.');
    assert.ok(groupAt - sent[4]! >= TABLEAU_MUTATION_BLOCK_PAUSE_MS - 10, 'The group write is the sixth paced send, so it waits for the block pause.');
  } finally { await run.app.close(); }
});

test('a publication Tableau limits answers as a publish job whose total counts creates and follows', async () => {
  let creates = 0;
  let follows = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return ++creates === 2 ? limited(1) : created(`definition-${creates}`);
    assert.ok(isSubscribe(input));
    follows++;
    return confirmed(init);
  };
  const run = await fixture('self', 2);
  try {
    const started = await run.publish();
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.kind, 'publish');
    assert.equal(started.json().job.total, 4);
    assert.equal(started.json().job.completed, 1);
    const response = await finish(run.app, started);
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.equal(receipt.id, run.request.commandId);
    assert.deepEqual(receipt.items.map((item: { creationStatus: string }) => item.creationStatus), ['created', 'created']);
    assert.deepEqual(receipt.follow.subscriptions.map((row: { status: string }) => row.status), ['created', 'created']);
    assert.equal(creates, 3, 'The throttled create is resent once.');
    assert.equal(follows, 2);
  } finally { await run.app.close(); }
});

test('cancelling a throttled publication sends nothing more and reports later metrics and follows as not sent', async () => {
  let creates = 0;
  let follows = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return ++creates === 2 ? limited(60) : created(`definition-${creates}`);
    follows++;
    return confirmed(init);
  };
  const run = await fixture('self', 3);
  try {
    const started = await run.publish();
    assert.equal(started.statusCode, 202, started.body);
    const cancelled = await run.cancel(started);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().job.state, 'stopping');
    const response = await finish(run.app, cancelled);
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.deepEqual(receipt.items.map((item: { creationStatus: string }) => item.creationStatus), ['created', 'not_attempted', 'not_attempted']);
    assert.equal(receipt.items[0].diagnostic, null);
    for (const item of receipt.items.slice(1)) assert.equal(item.diagnostic?.message, NOT_SENT);
    assert.deepEqual(receipt.follow.subscriptions.map((row: { status: string }) => row.status), ['not_attempted', 'not_attempted', 'not_attempted']);
    assert.equal(receipt.unknownCount, 0);
    assert.equal(receipt.unattemptedCount, 2);
    assert.equal(creates, 2, 'A create waiting out a throttle is never resent after Cancel.');
    assert.equal(follows, 0);
    assert.deepEqual((await run.read()).json().items, receipt.items);
  } finally { await run.app.close(); }
});

test('an ambiguous create failure stays unknown and the publication continues', async () => {
  let creates = 0;
  globalThis.fetch = async (input, init) => {
    assert.ok(isCreate(input, init));
    return ++creates === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : created(`definition-${creates}`);
  };
  const run = await fixture('none', 2);
  try {
    const response = await run.publish();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().items.map((item: { creationStatus: string }) => item.creationStatus), ['unknown', 'created']);
    assert.notEqual(response.json().items[0].diagnostic?.message, NOT_SENT);
  } finally { await run.app.close(); }
});

test('a publication follows every confirmed metric in one paced subscription batch', async () => {
  const calls: number[] = [];
  let follows = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return created(`definition-${crypto.randomUUID()}`);
    return ++follows === 1 ? limited(1) : confirmed(init);
  };
  const run = await fixture('self', 3, { subscribeUser: async (session, items) => { calls.push(items.length); return batchCreateUserSubscriptions(session, items); } });
  try {
    const started = await run.publish();
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.total, 6);
    assert.equal(started.json().job.completed, 3, 'Every create is final before the subscription batch starts.');
    const response = await finish(run.app, started);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls, [3]);
    assert.deepEqual(response.json().follow.subscriptions.map((row: { status: string }) => row.status), ['created', 'created', 'created']);
    assert.equal(follows, 4);
  } finally { await run.app.close(); }
});

test('cancelling a throttled subscription batch keeps confirmed follows and reports the rest as not sent', async () => {
  let follows = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return created(`definition-${crypto.randomUUID()}`);
    return ++follows === 2 ? limited(60) : confirmed(init);
  };
  const run = await fixture('self', 3);
  try {
    const started = await run.publish();
    assert.equal(started.statusCode, 202, started.body);
    const response = await finish(run.app, await run.cancel(started));
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.deepEqual(receipt.items.map((item: { creationStatus: string }) => item.creationStatus), ['created', 'created', 'created']);
    assert.deepEqual(receipt.follow.subscriptions.map((row: { status: string }) => row.status), ['created', 'not_attempted', 'not_attempted']);
    assert.ok(receipt.follow.subscriptions.slice(1).every((row: { error?: string }) => row.error));
    assert.equal(follows, 2);
  } finally { await run.app.close(); }
});

test('cancelling a throttled undo keeps confirmed deletions and restores the metrics it did not send', async () => {
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return created(`definition-${crypto.randomUUID()}`);
    assert.equal(init?.method, 'DELETE');
    return ++deletes === 2 ? limited(60) : new Response(null, { status: 204 });
  };
  const run = await fixture('none', 3);
  try {
    assert.equal((await run.publish()).statusCode, 200);
    const started = await run.undo();
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.kind, 'undo');
    assert.equal(started.json().job.total, 3);
    assert.equal(started.json().job.completed, 1);
    const response = await finish(run.app, await run.cancel(started));
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json();
    assert.deepEqual(receipt.items.map((item: { undoStatus: string }) => item.undoStatus), ['deleted', 'pending', 'pending']);
    assert.ok(receipt.items.every((item: { undoDiagnostic: unknown }) => item.undoDiagnostic === null));
    assert.equal(receipt.undoEligible, true);
    assert.equal(deletes, 2);
    assert.deepEqual((await run.read()).json().items, receipt.items);
  } finally { await run.app.close(); }
});

test('an undo that finishes answers inline with its receipt', async () => {
  globalThis.fetch = async (input, init) => isCreate(input, init) ? created(`definition-${crypto.randomUUID()}`) : new Response(null, { status: 204 });
  const run = await fixture('none', 1);
  try {
    assert.equal((await run.publish()).statusCode, 200);
    const response = await run.undo();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items[0].undoStatus, 'deleted');
  } finally { await run.app.close(); }
});

test('cancelling a throttled group deletion restores its previous outcome', async () => {
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    if (isCreate(input, init)) return created(`definition-${crypto.randomUUID()}`);
    assert.equal(init?.method, 'DELETE');
    deletes++;
    return limited(60);
  };
  const run = await fixture('group', 1, {
    ensureGroup: async () => ({ id: 'created-group', name: 'Audience', existedBefore: false }),
    addMember: async () => {}, subscribe: async (_session, items) => items.map((item) => ({ ...item, targetId: item.groupId, ok: true, alreadyExists: false })),
  });
  try {
    assert.equal((await run.publish()).statusCode, 200);
    const started = await run.deleteGroup('created-group');
    assert.equal(started.statusCode, 202, started.body);
    assert.equal(started.json().job.kind, 'group_delete');
    assert.equal(started.json().job.total, 1);
    const response = await finish(run.app, await run.cancel(started));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().follow.group.status, 'created');
    assert.equal(response.json().follow.group.deletion, undefined);
    assert.equal((await run.read()).json().follow.group.deletion, undefined);
    assert.equal(deletes, 1);
  } finally { await run.app.close(); }
});

test('job routes reject a missing owner before starting a job', async () => {
  globalThis.fetch = async (input, init) => isCreate(input, init) ? created(`definition-${crypto.randomUUID()}`) : new Response(null, { status: 204 });
  const run = await fixture('none', 1);
  try {
    assert.equal((await run.publish()).statusCode, 200);
    clearSession();
    assert.equal((await run.undo()).statusCode, 401);
    const repeated = await run.publish();
    assert.equal(repeated.statusCode, 200, 'A repeated command answers with its receipt without a connection.');
    assert.equal(repeated.json().id, run.request.commandId);
  } finally { await run.app.close(); }
});
