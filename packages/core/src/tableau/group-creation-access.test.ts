import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-group-access-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = directory;
const sessions = await import('./session.js');
const { closeDb } = await import('../db/index.js');
const { registerTableauRoutes } = await import('./routes.js');
test.afterEach(() => sessions.clearSession());
test.after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

function actor(serverUrl = 'https://fixture.online.tableau.com') {
  return { serverUrl, siteContentUrl: 'fixture', siteId: 'fixture-site', userId: 'fixture-user', userName: 'Existing display', token: 'fixture-token', apiVersion: '3.27' };
}
async function fixture(fetchImpl: typeof fetch) {
  const app = Fastify();
  await app.register(sensible);
  registerTableauRoutes(app, { fetchImpl, discoverRestApiVersion: async () => '3.27', patSignin: async () => ({ token: 'fixture-token', siteId: 'fixture-site', userId: 'fixture-user' }) });
  return app;
}

test('real status response derives group creation from verified own-user metadata and refreshes an already named user', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let role = 'Creator';
  const paths: string[] = [];
  const app = await fixture(async (input) => {
    paths.push(new URL(String(input)).pathname);
    return Response.json({ user: { id: owner.userId, fullName: 'Current display', siteRole: role } });
  });
  try {
    const first = (await app.inject('/api/tableau/status')).json();
    assert.equal(first.connected, true);
    assert.equal(first.session.siteRole, 'Creator');
    assert.equal(first.session.groupCreation.state, 'denied');
    assert.equal(typeof first.session.groupCreation.checkedAt, 'number');
    role = 'SiteAdministratorCreator';
    const second = (await app.inject('/api/tableau/status')).json();
    assert.equal(second.session.groupCreation.state, 'allowed');
    assert.equal(second.session.userName, 'Current display');
    assert.equal(paths.length, 2);
    assert.ok(paths.every((value) => value.endsWith('/users/current')));
  } finally { await app.close(); }
});

test('wrong-user metadata, unknown roles, and transient status failure never grant group access or clear valid authentication', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let payload: unknown = { user: { id: 'other-user', siteRole: 'SiteAdministratorCreator' } };
  let status = 200;
  const app = await fixture(async () => Response.json(payload, { status }));
  try {
    const mismatched = (await app.inject('/api/tableau/status')).json();
    assert.equal(mismatched.session.groupCreation.state, 'unknown');
    assert.equal(mismatched.session.siteRole, undefined);
    payload = { user: { id: owner.userId, siteRole: 'FutureRole' } };
    assert.equal((await app.inject('/api/tableau/status')).json().session.groupCreation.state, 'unknown');
    status = 503;
    const unavailable = (await app.inject('/api/tableau/status')).json();
    assert.equal(unavailable.connected, true);
    assert.equal(unavailable.reachable, false);
    assert.equal(unavailable.session.groupCreation.state, 'unknown');
    assert.equal(sessions.getSession(), owner);
  } finally { await app.close(); }
});

test('sign-in reuses its existing own-user read and does not infer Server delegated capabilities from a non-admin role', async () => {
  let reads = 0;
  const app = await fixture(async () => {
    reads++;
    return Response.json({ user: { id: 'fixture-user', siteRole: 'Creator' } });
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/tableau/connect', payload: {
      operationId: crypto.randomUUID(), serverUrl: 'https://server.example.test', siteContentUrl: 'fixture', patName: 'fixture', storageKind: 'encrypted', patSecret: 'fixture-pat', explicitFallback: true,
    } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().session.groupCreation.state, 'unknown');
    assert.equal(response.json().session.siteRole, 'Creator');
    assert.equal(reads, 1);
  } finally { await app.close(); }
});

test('a delayed old-owner role response cannot grant access to a replacement session', async () => {
  const first = actor();
  sessions.setSession(first, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let finish!: (value: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const app = await fixture(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  try {
    const pending = app.inject('/api/tableau/status').then((response) => response);
    await ready;
    const replacement = { ...actor(), userId: 'replacement-user' };
    sessions.setSession(replacement, { connectionId: 'replacement-connection', patSecret: 'replacement-pat' });
    finish(Response.json({ user: { id: first.userId, siteRole: 'SiteAdministratorCreator' } }));
    const result = (await pending).json();
    assert.equal(result.session.userId, replacement.userId);
    assert.equal(result.session.groupCreation.state, 'unknown');
    assert.equal(result.session.siteRole, undefined);
  } finally { await app.close(); }
});

test('same-object reactivation clears verified access and rejects an earlier generation response', async () => {
  const owner = actor();
  const credential = { connectionId: 'fixture-connection', patSecret: 'fixture-pat' };
  sessions.setSession(owner, credential);
  let finish!: (value: Response) => void;
  let started!: () => void;
  let delayed = false;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const app = await fixture(() => delayed ? new Promise((resolve) => { finish = resolve; started(); })
    : Promise.resolve(Response.json({ user: { id: owner.userId, siteRole: 'SiteAdministratorExplorer' } })));
  try {
    await app.inject('/api/tableau/status');
    assert.equal(sessions.getGroupCreationAccess(owner).state, 'allowed');
    delayed = true;
    const pending = app.inject('/api/tableau/status').then((response) => response);
    await ready;
    sessions.setSession(owner, credential);
    assert.equal(sessions.getGroupCreationAccess(owner).state, 'unknown');
    finish(Response.json({ user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } }));
    const result = (await pending).json();
    assert.equal(result.session.groupCreation.state, 'unknown');
    assert.equal(result.reachable, false);
    assert.equal(sessions.getSession(), owner);
  } finally { await app.close(); }
});

test('unrecognized Cloud roles and non-admin custom hosts never infer group creation access', async () => {
  for (const [serverUrl, role] of [
    ['https://fixture.online.tableau.com', 'FutureAdministrator'],
    ['https://fixture.online.tableau.com.evil.example', 'Creator'],
  ]) {
    const owner = actor(serverUrl);
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    const app = await fixture(async () => Response.json({ user: { id: owner.userId, siteRole: role } }));
    try { assert.equal((await app.inject('/api/tableau/status')).json().session.groupCreation.state, 'unknown'); }
    finally { await app.close(); }
  }
});

test('verified administrator roles establish group access on Server and custom hosts without extra probes', async () => {
  for (const role of ['ServerAdministrator', 'SiteAdministratorCreator', 'SiteAdministratorExplorer']) {
    const owner = actor('https://server.example.test');
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    let reads = 0;
    const app = await fixture(async () => { reads++; return Response.json({ user: { id: owner.userId, siteRole: role } }); });
    try {
      assert.equal((await app.inject('/api/tableau/status')).json().session.groupCreation.state, 'allowed');
      assert.equal(reads, 1);
    } finally { await app.close(); }
  }
});
