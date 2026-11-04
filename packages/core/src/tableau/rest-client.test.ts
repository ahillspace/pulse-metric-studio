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
const { tableauFetch, getJson, DEFAULT_MAX_RESPONSE_BYTES, MAX_CONCURRENT_TABLEAU_REQUESTS } = await import('./rest-client.js');
const { patSignin } = await import('./signin.js');

test.after(() => { sessions.clearSession(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

async function fixture() {
  const requests: Array<{ path: string; token: string; host: string }> = [];
  const pending: ServerResponse[] = [];
  let signins = 0;
  let holdSignin = false;
  let signinResponse: ServerResponse | undefined;
  const heldSignins: Array<{ response: ServerResponse; token: string }> = [];
  let workHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url!;
    requests.push({ path, token: String(req.headers['x-tableau-auth'] ?? ''), host: req.headers.host! });
    res.setHeader('Content-Type', 'application/json');
    if (path.endsWith('/serverInfo')) res.end(JSON.stringify({ serverInfo: { restApiVersion: { number: '3.27' } } }));
    else if (path.endsWith('/auth/signin')) {
      signins++;
      if (holdSignin) { signinResponse = res; heldSignins.push({ response: res, token: `token-${signins}` }); }
      else res.end(JSON.stringify({ credentials: { token: `token-${signins}`, site: { id: 'site' }, user: { id: 'user' } } }));
    } else if (path.endsWith('/users/user')) {
      res.statusCode = req.headers['x-tableau-auth'] === `token-${signins}` ? 200 : 401;
      res.end('{}');
    }
    else if (workHandler) workHandler(req, res);
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
    serveWork(handler: (request: IncomingMessage, response: ServerResponse) => void) { workHandler = handler; },
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

test('status and activation discard oversized display-name responses without losing the session', async () => {
  for (const operation of ['status', 'activate'] as const) {
    const profile = sessions.saveConnection({ label: 'Bounded name', serverUrl: 'https://bounded.example.test', siteContentUrl: '', patName: 'test', storageKind: 'encrypted', patSecret: 'test-pat' });
    const session = { serverUrl: profile.serverUrl, siteContentUrl: '', siteId: 'site', userId: 'user', token: 'test-token', apiVersion: '3.27' };
    sessions.setSession(session, { connectionId: profile.id, patSecret: 'test-pat' });
    const app = Fastify();
    await app.register(sensible);
    registerTableauRoutes(app, {
      discoverRestApiVersion: async () => '3.27',
      patSignin: async () => ({ token: 'test-token', siteId: 'site', userId: 'user' }),
      fetchImpl: async () => Response.json({ user: { fullName: 'Unbounded name' } }, { headers: { 'content-length': String(DEFAULT_MAX_RESPONSE_BYTES + 1) } }),
    });
    try {
      const result = await app.inject({ method: operation === 'status' ? 'GET' : 'POST', url: operation === 'status' ? '/api/tableau/status' : `/api/tableau/connections/${profile.id}/activate` });
      assert.equal(result.statusCode, 200);
      assert.ok(result.json().connected === true || result.json().ok === true);
      assert.equal(sessions.getSession()?.userName, undefined);
    } finally {
      sessions.clearSession();
      await app.close();
    }
  }
});
function reject(res: ServerResponse) { res.statusCode = 401; res.end('{}'); }

test('status preserves a current session on temporary provider failures', async () => {
  for (const failure of [429, 503, 'timeout', 'network', 401] as const) {
    const profile = sessions.saveConnection({ label: 'Status', serverUrl: 'https://status.example.test', siteContentUrl: '', patName: 'test', storageKind: 'encrypted', patSecret: 'test-pat' });
    const owner = { serverUrl: profile.serverUrl, siteContentUrl: '', siteId: 'site', userId: 'user', token: 'test-token', apiVersion: '3.27' };
    sessions.setSession(owner, { connectionId: profile.id, patSecret: 'test-pat' });
    const app = Fastify();
    await app.register(sensible);
    registerTableauRoutes(app, { fetchImpl: async () => {
      if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      if (failure === 'network') throw new TypeError('Unavailable');
      return new Response('{}', { status: failure });
    } });
    try {
      const response = (await app.inject({ method: 'GET', url: '/api/tableau/status' })).json();
      assert.equal(response.connected, failure !== 401);
      assert.equal(sessions.getSession(), failure === 401 ? null : owner);
      if (failure !== 401) {
        assert.equal(response.reachable, false);
        assert.match(response.availabilityError, failure === 'timeout' ? /timed out/ : failure === 'network' ? /could not reach/ : new RegExp(`HTTP ${failure}`));
      }
    } finally { sessions.clearSession(); await app.close(); }
  }
});

test('a late status response never rejects or clears the replacement session', async () => {
  for (const status of [200, 401, 503]) {
    const profile = sessions.saveConnection({ label: 'Status switch', serverUrl: 'https://status-switch.example.test', siteContentUrl: '', patName: 'test', storageKind: 'encrypted', patSecret: 'test-pat' });
    const first = { serverUrl: profile.serverUrl, siteContentUrl: '', siteId: 'site', userId: 'first', token: 'first-token', apiVersion: '3.27' };
    sessions.setSession(first, { connectionId: profile.id, patSecret: 'test-pat' });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const app = Fastify();
    await app.register(sensible);
    registerTableauRoutes(app, { fetchImpl: async () => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); } });
    try {
      const request = app.inject({ method: 'GET', url: '/api/tableau/status' });
      void request.then(() => {});
      await dispatched;
      const replacement = { ...first, userId: 'replacement', token: 'replacement-token' };
      sessions.setSession(replacement, { connectionId: profile.id, patSecret: 'test-pat' });
      finish(Response.json({}, { status }));
      const result = (await request).json();
      assert.equal(sessions.getSession(), replacement);
      assert.equal(result.connected, true);
      assert.equal(result.session.userId, 'replacement');
      assert.equal(result.reachable, false, 'the old status request does not establish reachability for a new owner');
    } finally { sessions.clearSession(); await app.close(); }
  }
});

for (const action of ['switch', 'disconnect'] as const) {
  test(`late A 401 cannot refresh after ${action}`, async () => {
    const f = await fixture();
    try {
      const request = tableauFetch(f.session, '/work');
      await until(() => f.pending.length === 1);
      const response = await f.app.inject({ method: 'POST', url: action === 'switch' ? `/api/tableau/connections/${f.b.id}/activate` : '/api/tableau/disconnect', payload: { connectionId: sessions.getSessionContext(f.session)!.connectionId, sessionGeneration: sessions.getSessionGeneration() } });
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
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: { connectionId: sessions.getSessionContext(f.session)!.connectionId, sessionGeneration: sessions.getSessionGeneration() } });
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
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: { connectionId: sessions.getSessionContext(f.session)!.connectionId, sessionGeneration: sessions.getSessionGeneration() } });
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
    await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: { connectionId: sessions.getSessionContext(f.session)!.connectionId, sessionGeneration: sessions.getSessionGeneration() } });
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
      const change = await f.app.inject({ method: 'POST', url: action === 'disconnect' ? '/api/tableau/disconnect' : `/api/tableau/connections/${f.b.id}/activate`, payload: { connectionId: sessions.getSessionContext(f.session)!.connectionId, sessionGeneration: sessions.getSessionGeneration() } });
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

test('delayed disconnect cannot clear another connection or a newer activation of the same connection', async () => {
  const f = await fixture();
  try {
    const original = sessions.getSessionContext(f.session)!;
    const disconnectA = { connectionId: original.connectionId, sessionGeneration: original.generation };
    const activated = await f.app.inject({ method: 'POST', url: `/api/tableau/connections/${f.b.id}/activate` });
    assert.equal(activated.statusCode, 200);
    const firstB = activated.json().session;
    assert.equal(typeof firstB.sessionGeneration, 'number');
    const staleA = await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: disconnectA });
    assert.equal(staleA.statusCode, 409);
    assert.equal(sessions.getSessionContext(sessions.getSession()!)?.connectionId, f.b.id);

    const reactivated = await f.app.inject({ method: 'POST', url: `/api/tableau/connections/${f.b.id}/activate` });
    assert.equal(reactivated.statusCode, 200);
    const currentB = reactivated.json().session;
    assert.notEqual(currentB.sessionGeneration, firstB.sessionGeneration);
    const staleB = await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: { connectionId: f.b.id, sessionGeneration: firstB.sessionGeneration } });
    assert.equal(staleB.statusCode, 409);
    assert.equal(sessions.getSessionContext(sessions.getSession()!)?.generation, currentB.sessionGeneration);
    const disconnected = await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload: { connectionId: f.b.id, sessionGeneration: currentB.sessionGeneration } });
    assert.equal(disconnected.statusCode, 200);
    assert.equal(sessions.getSession(), null);
  } finally { await f.close(); }
});

test('disconnect validates its expected owner before changing the session', async () => {
  const f = await fixture();
  try {
    for (const payload of [undefined, {}, { connectionId: 'a', sessionGeneration: '1' }, { connectionId: '', sessionGeneration: 1 }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/tableau/disconnect', payload })).statusCode, 400);
      assert.equal(sessions.getSession(), f.session);
    }
  } finally { await f.close(); }
});


test('late status rejection cannot invalidate a token refreshed by an ordinary request', async () => {
  const f = await fixture();
  let release!: (response: Response) => void;
  let statusToken = '';
  const app = Fastify();
  await app.register(sensible);
  registerTableauRoutes(app, { fetchImpl: async (_input, init) => {
    statusToken = new Headers(init?.headers).get('X-Tableau-Auth') ?? '';
    if (statusToken !== 'old') return Response.json({ user: { id: 'user', siteRole: 'Creator' } });
    return new Promise<Response>((resolve) => { release = resolve; });
  } });
  try {
    const status = app.inject('/api/tableau/status').then(response => response.json());
    await until(() => !!release);
    const request = tableauFetch(f.session, '/api/3.27/test');
    await until(() => f.pending.length === 1);
    reject(f.pending.shift()!);
    assert.equal((await request).status, 200);
    assert.equal(f.session.token, 'token-1');
    release(new Response('{}', { status: 401 }));
    const result = await status;
    assert.equal(result.connected, true);
    assert.equal(result.reachable, true);
    assert.equal(statusToken, 'token-1');
    assert.equal(sessions.getSession(), f.session);
  } finally { await app.close(); await f.close(); }
});

test('queued request times out before a held capacity slot is released', async () => {
  const owner = { serverUrl: 'https://gate.example.test', siteContentUrl: '', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  const original = globalThis.fetch;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; await held; return Response.json({}); };
  const active = Array.from({ length: 8 }, () => tableauFetch(owner, '/api/3.27/hold', { timeoutMs: 3000 }));
  try {
    await until(() => calls === 8);
    const ninth = tableauFetch(owner, '/api/3.27/wait', { timeoutMs: 30 }).then(() => 'resolved', () => 'timed out');
    const next = tableauFetch(owner, '/api/3.27/next', { timeoutMs: 2000 });
    const outcome = await Promise.race([ninth, new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 300))]);
    assert.equal(outcome, 'timed out');
    assert.equal(calls, 8);
    release();
    assert.equal((await next).status, 200);
    assert.equal(calls, 9);
  } finally { release(); await Promise.all(active); globalThis.fetch = original; }
});

test('queued exact reads recover together after throttling and a successful token refresh', async (t) => {
  const f = await fixture();
  const firstWave: ServerResponse[] = [];
  const freshBodies: Array<{ response: ServerResponse; id: string }> = [];
  let workCalls = 0;
  let expiredTokenCalls = 0;
  let freshTokenCalls = 0;
  const expiredTokenPaths: string[] = [];
  const freshTokenPaths: string[] = [];
  let releaseFreshBodies = false;
  f.serveWork((req, res) => {
    if (++workCalls <= MAX_CONCURRENT_TABLEAU_REQUESTS) { firstWave.push(res); return; }
    if (req.headers['x-tableau-auth'] === 'old') { expiredTokenCalls++; expiredTokenPaths.push(req.url!); reject(res); return; }
    assert.equal(req.headers['x-tableau-auth'], 'token-1');
    freshTokenCalls++;
    freshTokenPaths.push(req.url!);
    const id = req.url!.split('/').at(-1)!;
    if (releaseFreshBodies) res.end(JSON.stringify({ metric: { id } }));
    else { res.write(' '); freshBodies.push({ response: res, id }); }
  });
  const reads = Array.from({ length: 25 }, (_, index) => getJson<{ metric: { id: string } }>(
    f.session, `/api/-/pulse/metrics/${index}`, undefined, 4500,
  ));
  const results = Promise.allSettled(reads);
  try {
    await until(() => firstWave.length === MAX_CONCURRENT_TABLEAU_REQUESTS);
    for (const response of firstWave) { response.writeHead(429, { 'Retry-After': '0' }); response.end('{}'); }
    // The provider's first fresh response stays open to exercise the recovery body lease.
    const settled = results.then(() => true);
    const recovered = await Promise.race([
      (async () => { await until(() => freshBodies.length > 0); return true; })().catch(() => false),
      settled.then(() => false),
    ]);
    if (recovered) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(freshTokenCalls, 1, 'the refreshed probe retains its lease until its body is consumed');
    }
    releaseFreshBodies = true;
    for (const { response, id } of freshBodies) response.end(JSON.stringify({ metric: { id } }));
    const outcomes = await results;
    const summary = { successes: outcomes.filter(result => result.status === 'fulfilled').length, expiredTokenCalls, freshTokenCalls, signins: f.signins };
    t.diagnostic(JSON.stringify(summary));
    assert.equal(summary.successes, 25, JSON.stringify(summary));
    assert.equal(recovered, true, 'the recovery probe must reach a fresh-token response before its original deadline');
    assert.equal(expiredTokenCalls, 1, JSON.stringify(summary));
    assert.equal(freshTokenCalls, 25, JSON.stringify(summary));
    assert.equal(f.signins, 1, JSON.stringify(summary));
    assert.equal(freshTokenPaths[0], expiredTokenPaths[0], 'the authenticated replay keeps the original recovery lease ahead of queued work');
    assert.deepEqual(outcomes.map(result => result.status === 'fulfilled' ? result.value.metric.id : null), Array.from({ length: 25 }, (_, index) => String(index)));
  } finally {
    for (const response of firstWave) if (!response.writableEnded) response.end('{}');
    for (const { response } of freshBodies) if (!response.writableEnded) response.end('{}');
    await results;
    await f.close();
  }
});

for (const change of ['disconnect', 'replacement', 'reactivation'] as const) {
  test(`throttled queued reads never adopt a new owner token after ${change} during refresh`, async () => {
    const f = await fixture();
    const firstWave: ServerResponse[] = [];
    f.hold();
    f.serveWork((_req, res) => {
      if (firstWave.length < MAX_CONCURRENT_TABLEAU_REQUESTS) firstWave.push(res);
      else reject(res);
    });
    const results = Promise.allSettled(Array.from({ length: 25 }, (_, index) => tableauFetch(
      f.session, `/api/-/pulse/metrics/${index}`, { timeoutMs: 3500 },
    )));
    try {
      await until(() => firstWave.length === MAX_CONCURRENT_TABLEAU_REQUESTS);
      for (const response of firstWave) { response.writeHead(429, { 'Retry-After': '0' }); response.end('{}'); }
      await until(() => f.signinPending);
      const context = sessions.getSessionContext(f.session)!;
      if (change === 'disconnect') sessions.clearSession();
      else {
        const next = change === 'reactivation' ? f.session : { ...f.session };
        next.token = 'replacement-token';
        sessions.setSession(next, { connectionId: context.connectionId, patSecret: 'a-secret' });
      }
      const replacement = sessions.getSession();
      f.releaseSignin();
      const outcomes = await results;
      assert.equal(outcomes.some(result => result.status === 'fulfilled' && result.value.ok), false);
      const sentReads = f.requests.filter(request => request.path.startsWith('/api/-/pulse/metrics/'));
      assert.equal(sentReads.length, MAX_CONCURRENT_TABLEAU_REQUESTS + 1, 'queued stale owners must fail without dispatch');
      assert.ok(sentReads.every(request => request.token === 'old'), 'the replacement token cannot reach paths captured by another session');
      assert.equal(f.signins, 1);
      assert.equal(sessions.getSession(), replacement);
      if (replacement) assert.equal(replacement.token, 'replacement-token');
    } finally {
      f.releaseSignin();
      for (const response of firstWave) if (!response.writableEnded) response.end('{}');
      await results;
      await f.close();
    }
  });
}
