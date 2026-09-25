import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const dataDir = mkdtempSync(join(tmpdir(), 'pulse-metric-studio-auth-race-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = dataDir;
const sessions = await import('./session.js');
const { closeDb } = await import('../db/index.js');
const { registerTableauRoutes } = await import('./routes.js');
const { tableauFetch } = await import('./rest-client.js');
const { patSignin } = await import('./signin.js');

test.after(() => { sessions.clearSession(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

async function fixture() {
  const requests: Array<{ path: string; token: string; host: string }> = [];
  const pending: ServerResponse[] = [];
  let signins = 0;
  let holdSignin = false;
  let signinResponse: ServerResponse | undefined;
  const heldSignins: Array<{ response: ServerResponse; token: string }> = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url!;
    requests.push({ path, token: String(req.headers['x-tableau-auth'] ?? ''), host: req.headers.host! });
    res.setHeader('Content-Type', 'application/json');
    if (path.endsWith('/serverInfo')) res.end(JSON.stringify({ serverInfo: { restApiVersion: { number: '3.27' } } }));
    else if (path.endsWith('/auth/signin')) {
      signins++;
      if (holdSignin) { signinResponse = res; heldSignins.push({ response: res, token: `token-${signins}` }); }
      else res.end(JSON.stringify({ credentials: { token: `token-${signins}`, site: { id: 'site' }, user: { id: 'user' } } }));
    } else if (path.endsWith('/users/current')) {
      res.statusCode = req.headers['x-tableau-auth'] === `token-${signins}` ? 200 : 401;
      res.end('{}');
    }
    else if (req.headers['x-tableau-auth'] === 'old') pending.push(res);
    else res.end('{}');
  };
  const remote = createServer(handler);
  const remoteB = createServer(handler);
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => remoteB.listen(0, '127.0.0.1', resolve));
  const address = remote.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const a = sessions.saveConnection({ label: 'A', serverUrl: origin, siteContentUrl: '', patName: 'a', storageKind: 'encrypted', patSecret: 'a-secret' });
  const originB = `http://127.0.0.1:${(remoteB.address() as { port: number }).port}`;
  const b = sessions.saveConnection({ label: 'B', serverUrl: originB, siteContentUrl: 'b', patName: 'b', storageKind: 'encrypted', patSecret: 'b-secret' });
  sessions.setActiveConnection(a.id);
  const session = { serverUrl: origin, siteContentUrl: '', siteId: 'site', userId: 'user', token: 'old', apiVersion: '3.27' };
  sessions.setSession(session, { connectionId: a.id, patSecret: 'a-secret' });
  const app = Fastify();
  await app.register(sensible);
  registerTableauRoutes(app);
  return { app, session, b, pending, requests, get signins() { return signins; },
    hold() { holdSignin = true; },
    allowSignins() { holdSignin = false; },
    releaseSignin(status = 200) { for (const { response, token } of heldSignins.splice(0)) { response.statusCode = status; response.end(JSON.stringify({ credentials: { token, site: { id: 'site' }, user: { id: 'user' } } })); } holdSignin = false; },
    get signinPending() { return !!signinResponse; },
    async close() { sessions.clearSession(); await app.close(); await Promise.all([remote, remoteB].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); },
  };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'Timed out waiting for remote request'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function reject(res: ServerResponse) { res.statusCode = 401; res.end('{}'); }

for (const action of ['switch', 'disconnect'] as const) {
  test(`late A 401 cannot refresh after ${action}`, async () => {
    const f = await fixture();
    try {
      const request = tableauFetch(f.session, '/work');
      await until(() => f.pending.length === 1);
      const response = await f.app.inject({ method: 'POST', url: action === 'switch' ? `/api/tableau/connections/${f.b.id}/activate` : '/api/tableau/disconnect' });
      assert.equal(response.statusCode, 200);
      const current = sessions.getSession();
      const signins = f.signins;
      reject(f.pending[0]);
      await request.catch(() => null);
      assert.equal(f.signins, signins, 'Stale request must not sign in');
      assert.equal(sessions.getSession(), current);
      assert.equal(f.requests.filter((r) => r.path === '/work').length, 1);
      assert.equal(f.requests.some((r) => r.host === new URL(f.session.serverUrl).host && r.token === current?.token), false);
    } finally { await f.close(); }
  });
}

test('simultaneous and late 401 responses share one replacement token', async () => {
  const f = await fixture();
  try {
    f.hold();
    const requests = [tableauFetch(f.session, '/one'), tableauFetch(f.session, '/two'), tableauFetch(f.session, '/late')];
    await until(() => f.pending.length === 3);
    reject(f.pending[0]); reject(f.pending[1]);
    await until(() => f.signinPending);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.signins, 1);
    f.releaseSignin();
    assert.equal((await requests[0]).status, 200);
    assert.equal((await requests[1]).status, 200);
    reject(f.pending[2]);
    assert.equal((await requests[2]).status, 200);
    assert.equal(f.signins, 1);
  } finally { await f.close(); }
});

test('failed refresh clears its promise and permits a later refresh', async () => {
  const f = await fixture();
  try {
    f.hold();
    const first = tableauFetch(f.session, '/first');
    await until(() => f.pending.length === 1); reject(f.pending[0]);
    await until(() => f.signinPending); f.releaseSignin(401);
    assert.equal((await first).status, 401);
    const second = tableauFetch(f.session, '/second');
    await until(() => f.pending.length === 2); reject(f.pending[1]);
    assert.equal((await second).status, 200);
    assert.equal(f.signins, 2);
  } finally { await f.close(); }
});

test('disconnect while refresh is pending cannot install or retry the token', async () => {
  const f = await fixture();
  try {
    f.hold();
    const request = tableauFetch(f.session, '/work');
    await until(() => f.pending.length === 1); reject(f.pending[0]);
    await until(() => f.signinPending);
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect' });
    f.releaseSignin();
    await request.catch(() => null);
    assert.equal(sessions.getSession(), null);
    assert.equal(f.requests.filter((r) => r.path === '/work').length, 1);
  } finally { await f.close(); }
});

test('disconnect while activation is pending prevents a late session install', async () => {
  const f = await fixture();
  try {
    f.hold();
    const activation = f.app.inject({ method: 'POST', url: `/api/tableau/connections/${f.b.id}/activate` });
    // Injection is lazy until its promise is observed.
    const result = activation.then((response) => response);
    await until(() => f.signinPending);
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect' });
    f.releaseSignin();
    assert.notEqual((await result).statusCode, 200);
    assert.equal(sessions.getSession(), null);
  } finally { await f.close(); }
});

test('a stale request cannot start a new HTTP operation', async () => {
  const f = await fixture();
  try {
    const context = sessions.getSessionContext(f.session)!;
    assert.equal(Object.isFrozen(context), true);
    assert.equal(context.serverUrl, f.session.serverUrl);
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect' });
    await assert.rejects(tableauFetch(f.session, '/work'), /connection changed/);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('reusing a session object cannot renew an older request generation', async () => {
  const f = await fixture();
  try {
    const context = sessions.getSessionContext(f.session)!;
    const request = tableauFetch(f.session, '/work');
    await until(() => f.pending.length === 1);
    sessions.clearSession();
    sessions.setSession(f.session, { connectionId: context.connectionId, patSecret: 'a-secret' });
    reject(f.pending[0]);
    assert.equal((await request).status, 401);
    assert.equal(f.signins, 0);
    assert.notEqual(sessions.getSessionContext(f.session)?.generation, context.generation);
  } finally { await f.close(); }
});

for (const operation of ['request', 'signin', 'status', 'activation-display-name'] as const) {
  test(`${operation} cannot forward credentials through an origin redirect`, async () => {
    let targetRequests = 0;
    let receivedCredentials = false;
    const target = createServer(async (req, res) => {
      targetRequests++;
      let body = '';
      for await (const chunk of req) body += String(chunk);
      receivedCredentials = req.headers['x-tableau-auth'] === 'test-token' || body.includes('test-pat');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ credentials: { token: 'redirected', site: { id: 'site' }, user: { id: 'user' } } }));
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/redirect-target`;
    const source = createServer((_req, res) => { res.writeHead(307, { Location: targetUrl }); res.end(); });
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    const profile = sessions.saveConnection({ label: 'Redirect test', serverUrl: origin, siteContentUrl: '', patName: 'test', storageKind: 'encrypted', patSecret: 'test-pat' });
    const session = { serverUrl: origin, siteContentUrl: '', siteId: 'site', userId: 'user', token: 'test-token', apiVersion: '3.27' };
    sessions.setSession(session, { connectionId: profile.id, patSecret: 'test-pat' });
    const app = Fastify();
    await app.register(sensible);
    registerTableauRoutes(app, {
      discoverRestApiVersion: async () => '3.27',
      patSignin: async () => ({ token: 'test-token', siteId: 'site', userId: 'user' }),
    });
    try {
      if (operation === 'request') await tableauFetch(session, '/work', { redirect: 'follow' }).catch(() => null);
      else if (operation === 'signin') await patSignin({ serverUrl: origin, siteContentUrl: '', patName: 'test', patSecret: 'test-pat', apiVersion: '3.27' }).catch(() => null);
      else await app.inject({ method: operation === 'status' ? 'GET' : 'POST', url: operation === 'status' ? '/api/tableau/status' : `/api/tableau/connections/${profile.id}/activate` });
      assert.equal(receivedCredentials, false, 'Redirect target received a Tableau token or PAT');
      assert.equal(targetRequests, 0, 'A credential-bearing request must never reach the redirect target');
    } finally {
      sessions.clearSession();
      await app.close();
      await Promise.all([source, target].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
}

for (const secondRequest of ['status', 'activate'] as const) {
  test(`cold restore shares sign-in with a concurrent ${secondRequest} request`, async () => {
    const f = await fixture();
    const connectionId = sessions.getSessionContext(f.session)!.connectionId;
    sessions.clearSession();
    f.hold();
    try {
      const first = f.app.inject({ method: 'GET', url: '/api/tableau/status' }).then((response) => response);
      await until(() => f.signinPending);
      const second = f.app.inject({ method: secondRequest === 'status' ? 'GET' : 'POST', url: secondRequest === 'status' ? '/api/tableau/status' : `/api/tableau/connections/${connectionId}/activate` }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const signins = f.signins;
      f.releaseSignin();
      const responses = await Promise.all([first, second]);
      assert.equal(signins, 1, 'Concurrent cold requests must sign in only once');
      assert.ok(responses.every((response) => response.statusCode === 200));
      assert.ok(responses.every((response) => response.json().connected === true || response.json().ok === true));
      assert.equal((await f.app.inject({ method: 'GET', url: '/api/tableau/status' })).json().connected, true);
    } finally { f.releaseSignin(); await f.close(); }
  });
}

for (const action of ['disconnect', 'switch'] as const) {
  test(`shared cold restore cannot install after ${action}`, async () => {
    const f = await fixture();
    sessions.clearSession();
    f.hold();
    try {
      const first = f.app.inject({ method: 'GET', url: '/api/tableau/status' }).then((response) => response);
      await until(() => f.signinPending);
      const second = f.app.inject({ method: 'GET', url: '/api/tableau/status' }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(f.signins, 1);
      f.allowSignins();
      const change = await f.app.inject({ method: 'POST', url: action === 'disconnect' ? '/api/tableau/disconnect' : `/api/tableau/connections/${f.b.id}/activate` });
      assert.equal(change.statusCode, 200);
      const current = sessions.getSession();
      f.releaseSignin();
      const responses = await Promise.all([first, second]);
      assert.ok(responses.every((response) => response.json().connected === false));
      assert.equal(sessions.getSession(), current);
      if (action === 'switch') {
        assert.equal(sessions.getSessionContext(current!)?.connectionId, f.b.id);
        assert.equal((await f.app.inject({ method: 'GET', url: '/api/tableau/status' })).json().connected, true);
      }
    } finally { f.releaseSignin(); await f.close(); }
  });
}

test('failed shared cold restore can be retried', async () => {
  const f = await fixture();
  sessions.clearSession();
  f.hold();
  try {
    const first = f.app.inject({ method: 'GET', url: '/api/tableau/status' }).then((response) => response);
    await until(() => f.signinPending);
    f.releaseSignin(401);
    assert.equal((await first).json().connected, false);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/tableau/status' })).json().connected, true);
    assert.equal(f.signins, 2);
  } finally { f.releaseSignin(); await f.close(); }
});
