import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { Writable } from 'node:stream';
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
    assert.ok(paths.every((value) => value.endsWith('/users/fixture-user')));
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

for (const [olderStatus, olderRole, newerStatus, newerRole, expectedAccess] of [
  [200, 'SiteAdministratorCreator', 200, 'Creator', 'denied'],
  [200, 'SiteAdministratorCreator', 503, undefined, 'unknown'],
  [401, undefined, 200, 'Creator', 'denied'],
  [503, undefined, 200, 'SiteAdministratorCreator', 'allowed'],
  [200, 'Creator', 200, 'SiteAdministratorCreator', 'allowed'],
] as const) {
  test(`same-owner older ${olderStatus}/${olderRole} cannot replace newer ${newerStatus}/${newerRole} status`, async () => {
    const owner = actor();
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    let finishOlder!: (response: Response) => void;
    let started!: () => void;
    let calls = 0;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const app = await fixture(async () => {
      calls++;
      if (calls === 1) return new Promise<Response>((resolve) => { finishOlder = resolve; started(); });
      return Response.json({ user: { id: owner.userId, siteRole: newerRole, fullName: 'Latest name' } }, { status: newerStatus });
    });
    try {
      const pendingOlder = app.inject('/api/tableau/status').then((response) => response.json());
      await ready;
      const newer = (await app.inject('/api/tableau/status')).json();
      assert.equal(newer.session.groupCreation.state, expectedAccess);
      finishOlder(Response.json({ user: { id: owner.userId, siteRole: olderRole, fullName: 'Stale name' } }, { status: olderStatus }));
      const older = await pendingOlder;
      assert.equal(sessions.getSession(), owner, 'a superseded auth failure must not clear the current session');
      assert.equal(sessions.getGroupCreationAccess(owner).state, expectedAccess, 'only latest own-user facts remain authoritative');
      assert.deepEqual(older, newer, 'superseded status must report latest facts and reachability');
      assert.equal(owner.userName, newerStatus === 200 ? 'Latest name' : 'Existing display');
      assert.equal(calls, 2, 'ordering must not add provider queries');
    } finally { await app.close(); }
  });
}

test('superseded status waits for the newest pending check instead of attributing old reachability', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  const finishes: Array<(response: Response) => void> = [];
  let started!: () => void;
  let ready = new Promise<void>((resolve) => { started = resolve; });
  const app = await fixture(() => new Promise<Response>((resolve) => { finishes.push(resolve); started(); }));
  try {
    const older = app.inject('/api/tableau/status').then((response) => response.json());
    await ready;
    ready = new Promise<void>((resolve) => { started = resolve; });
    const newer = app.inject('/api/tableau/status').then((response) => response.json());
    await ready;
    finishes[0](Response.json({ user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } }));
    finishes[1](Response.json({ unavailable: true }, { status: 503 }));
    const [oldResult, newResult] = await Promise.all([older, newer]);
    assert.equal(newResult.reachable, false);
    assert.equal(newResult.session.groupCreation.state, 'unknown');
    assert.deepEqual(oldResult, newResult);
    assert.equal(sessions.getGroupCreationAccess(owner).state, 'unknown');
    assert.equal(finishes.length, 2);
  } finally { await app.close(); }
});


test('own-profile permission failures preserve reachable sessions and explain unknown group access', async () => {
  for (const status of [403, 404]) {
    const owner = actor();
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    const app = await fixture(async (input) => {
      assert.ok(new URL(String(input)).pathname.endsWith('/users/fixture-user'));
      return Response.json({ error: { code: '404000', summary: 'profile unavailable' } }, { status });
    });
    try {
      const response = (await app.inject('/api/tableau/status')).json();
      assert.equal(response.connected, true);
      assert.equal(response.reachable, true);
      assert.equal(response.availabilityError, undefined);
      assert.equal(response.session.groupCreation.state, 'unknown');
      assert.equal(response.session.groupCreation.reasonCode, 'user_profile_unavailable');
      assert.equal(sessions.getSession(), owner);
    } finally { await app.close(); sessions.clearSession(); }
  }
});

test('sign-in own-profile read uses the authenticated user ID', async () => {
  const paths: string[] = [];
  const app = await fixture(async (input) => {
    paths.push(new URL(String(input)).pathname);
    return paths.at(-1)?.endsWith('/users/fixture-user')
      ? Response.json({ user: { id: 'fixture-user', siteRole: 'SiteAdministratorCreator' } })
      : new Response(null, { status: 404 });
  });
  try {
    const result = (await app.inject({ method: 'POST', url: '/api/tableau/connect', payload: {
      operationId: crypto.randomUUID(), serverUrl: 'https://server.example.test', siteContentUrl: 'fixture', patName: 'fixture', storageKind: 'encrypted', patSecret: 'fixture-pat', explicitFallback: true,
    } })).json();
    assert.equal(result.session.siteRole, 'SiteAdministratorCreator');
    assert.deepEqual(paths, ['/api/3.27/sites/fixture-site/users/fixture-user']);
  } finally { await app.close(); }
});


test('profile diagnostics report safe structured status without provider text or identifiers', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let log = '';
  const app = Fastify({ logger: { stream: new Writable({ write(chunk, _encoding, done) { log += chunk.toString(); done(); } }) } });
  await app.register(sensible);
  registerTableauRoutes(app, { fetchImpl: async () => Response.json({ error: { code: '503001', summary: `${owner.token} ${owner.serverUrl} ${owner.siteId} ${owner.userId}` } }, { status: 503 }) });
  try {
    const result = (await app.inject('/api/tableau/status')).json();
    assert.equal(result.connected, true);
    assert.equal(result.reachable, false);
    assert.match(result.availabilityError, /HTTP 503, code 503001/);
    assert.match(log, /"reason":"http_error"/);
    assert.match(log, /"code":"503001"/);
    for (const secret of [owner.token, owner.serverUrl, owner.siteId, owner.userId]) {
      assert.ok(!log.includes(secret));
      assert.ok(!result.availabilityError.includes(secret));
    }
  } finally { await app.close(); }
});

test('auth-classified profile 403 clears the current session', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  const app = await fixture(async () => Response.json({ error: { code: '403001' } }, { status: 403 }));
  try {
    const result = (await app.inject('/api/tableau/status')).json();
    assert.equal(result.connected, false);
    assert.equal(sessions.getSession(), null);
  } finally { await app.close(); }
});


test('network diagnostics retain only an allowlisted nested cause code', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let log = '';
  let causeCode = 'ENOTFOUND';
  const app = Fastify({ logger: { stream: new Writable({ write(chunk, _encoding, done) { log += chunk.toString(); done(); } }) } });
  await app.register(sensible);
  registerTableauRoutes(app, { fetchImpl: async () => { throw new TypeError(`fetch failed ${owner.serverUrl}`, { cause: Object.assign(new Error(owner.token), { code: causeCode }) }); } });
  try {
    const first = (await app.inject('/api/tableau/status')).json();
    assert.equal(first.connected, true);
    assert.equal(first.reachable, false);
    assert.match(log, /"networkCode":"ENOTFOUND"/);
    assert.ok(!log.includes(owner.serverUrl));
    assert.ok(!log.includes(owner.token));
    log = '';
    causeCode = 'PRIVATE_HOST_NAME';
    await app.inject('/api/tableau/status');
    assert.ok(!log.includes(causeCode));
    assert.ok(!log.includes('networkCode'));
  } finally { await app.close(); }
});


test('XML profile errors distinguish rejected authentication from optional permission failure', async () => {
  for (const [code, connected] of [['403001', false], ['403010', false], ['403999', true]] as const) {
    const owner = actor();
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    const app = await fixture(async () => new Response(`<tsResponse><error code="${code}"><summary>Forbidden</summary></error></tsResponse>`, { status: 403 }));
    try {
      const result = (await app.inject('/api/tableau/status')).json();
      assert.equal(result.connected, connected, code);
      if (connected) {
        assert.equal(result.reachable, true);
        assert.equal(result.session.groupCreation.reasonCode, 'user_profile_unavailable');
        assert.equal(sessions.getSession(), owner);
      } else assert.equal(sessions.getSession(), null);
    } finally { await app.close(); sessions.clearSession(); }
  }
});


test('unsafe XML profile error bodies cannot assert authentication rejection', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  const app = await fixture(async () => new Response('<!DOCTYPE x><tsResponse><error code="403001"><summary>Forbidden</summary></error></tsResponse>', { status: 403 }));
  try {
    const result = (await app.inject('/api/tableau/status')).json();
    assert.equal(result.connected, true);
    assert.equal(result.reachable, true);
    assert.equal(result.session.groupCreation.state, 'unknown');
    assert.equal(sessions.getSession(), owner);
  } finally { await app.close(); }
});


test('obsolete profile success and failure recheck the current token without applying old access', async () => {
  for (const oldStatus of [200, 503]) {
    const owner = actor();
    sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
    let release!: (response: Response) => void;
    let reads = 0;
    const app = await fixture(async () => {
      reads++;
      if (reads === 1) return new Promise<Response>(resolve => { release = resolve; });
      return Response.json({ user: { id: owner.userId, siteRole: 'Creator' } });
    });
    try {
      const pending = app.inject('/api/tableau/status').then(response => response.json());
      while (!release) await new Promise(resolve => setTimeout(resolve, 1));
      owner.token = 'refreshed-token';
      release(Response.json({ user: { id: owner.userId, siteRole: 'SiteAdministratorCreator' } }, { status: oldStatus }));
      const result = await pending;
      assert.equal(result.connected, true);
      assert.equal(result.reachable, true);
      assert.equal(result.session.siteRole, 'Creator');
      assert.equal(result.session.groupCreation.state, 'denied');
      assert.equal(reads, 2);
    } finally { await app.close(); sessions.clearSession(); }
  }
});

test('repeated token rotation bounds profile rechecks and preserves session', async () => {
  const owner = actor();
  sessions.setSession(owner, { connectionId: 'fixture-connection', patSecret: 'fixture-pat' });
  let reads = 0;
  const app = await fixture(async () => { owner.token = `new-token-${++reads}`; return new Response('{}', { status: 401 }); });
  try {
    const result = (await app.inject('/api/tableau/status')).json();
    assert.equal(result.connected, true);
    assert.equal(sessions.getSession(), owner);
    assert.equal(reads, 2);
  } finally { await app.close(); }
});
