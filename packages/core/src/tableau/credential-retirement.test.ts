import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

const dir = mkdtempSync(join(tmpdir(), 'pulse-retirement-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = dir;
const sessions = await import('./session.js');
const { closeDb, getDb } = await import('../db/index.js');
const { registerTableauRoutes } = await import('./routes.js');
test.after(() => { sessions.clearSession(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

test('replacement records durable retirement, protects shared refs, and safely retries cleanup', async () => {
  const secrets = new Map([['old-ref', 'old-secret'], ['new-ref', 'new-secret']]);
  const broker = { resolve: async (ref: string) => { const value = secrets.get(ref); if (!value) throw Error('missing'); return value; }, delete: async (ref: string) => secrets.delete(ref) };
  const first = sessions.saveConnection({ label: 'First', serverUrl: 'https://fixture.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'old-ref' });
  const second = sessions.saveConnection({ label: 'Second', serverUrl: 'https://fixture.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'old-ref' });
  const app = Fastify(); await app.register(sensible);
  registerTableauRoutes(app, { credentialBroker: broker, discoverRestApiVersion: async () => '3.27', patSignin: async () => ({ token: 'token', siteId: 'site', userId: 'user' }), fetchImpl: async () => Response.json({ user: { id: 'user' } }) });
  try {
    const replacement = await app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload: { operationId: crypto.randomUUID(), storageKind: 'os', credentialRef: 'new-ref', patName: 'fixture' } });
    assert.equal(replacement.statusCode, 200, replacement.body);
    const ticket = replacement.json().retirement.ticket;
    assert.equal((await app.inject(`/api/tableau/credential-retirements`)).json().retirements.length, 1);
    const retire = () => app.inject({ method: 'POST', url: `/api/tableau/credential-retirements/${ticket}` });
    assert.equal((await retire()).json().status, 'in_use');
    assert.equal(secrets.has('old-ref'), true);
    sessions.deleteConnection(second.id);
    assert.equal((await retire()).json().status, 'removed');
    assert.equal((await retire()).json().status, 'removed');
    assert.equal((await app.inject(`/api/tableau/credential-retirements`)).json().retirements.length, 0);
  } finally { await app.close(); }
});


test('retirement beats in-flight staged adoption and survives app restart', async () => {
  const secrets = new Map([['old-race', 'old-secret'], ['new-race', 'new-secret']]);
  let failDelete = true;
  const broker = { resolve: async (ref: string) => { const value = secrets.get(ref); if (!value) throw Error('missing'); return value; }, delete: async (ref: string) => { if (failDelete) throw Error('unavailable'); return secrets.delete(ref); } };
  let started!: () => void;
  const signinStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const signIn = async (input: { patSecret: string }) => { if (input.patSecret === 'old-secret') { started(); await held; } return { token: 'token', siteId: 'site', userId: 'user' }; };
  const makeApp = async () => { const app = Fastify(); await app.register(sensible); registerTableauRoutes(app, { credentialBroker: broker, discoverRestApiVersion: async () => '3.27', patSignin: signIn, fetchImpl: async () => Response.json({ user: { id: 'user' } }) }); return app; };
  const first = sessions.saveConnection({ label: 'Race', serverUrl: 'https://race.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'old-race' });
  let app = await makeApp();
  const payload = { operationId: crypto.randomUUID(), storageKind: 'os', credentialRef: 'new-race', patName: 'fixture' };
  const replacement = await app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload });
  assert.equal(replacement.statusCode, 200, replacement.body);
  const ticket = replacement.json().retirement.ticket;
  assert.equal((await app.inject({ method: 'POST', url: `/api/tableau/credential-retirements/${ticket}` })).json().status, 'cleanup_failed');
  await app.close(); sessions.clearSession(); closeDb(); app = await makeApp();
  try {
    assert.ok((await app.inject('/api/tableau/credential-retirements')).json().retirements.some((item: { ticket: string }) => item.ticket === ticket));
    const adoption = app.inject({ method: 'POST', url: '/api/tableau/connect', payload: { operationId: crypto.randomUUID(), serverUrl: 'https://other.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'old-race' } }).then(response => response);
    await signinStarted; failDelete = false;
    assert.equal((await app.inject({ method: 'POST', url: `/api/tableau/credential-retirements/${ticket}` })).json().status, 'removed');
    release();
    assert.notEqual((await adoption).statusCode, 200);
    assert.equal(sessions.listConnections().some(item => item.credentialRef === 'old-race'), false);
    const replay = await app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload });
    assert.equal(replay.json().retirement.ticket, ticket);
  } finally { release(); await app.close(); }
});


test('failure to record retirement rolls back replacement without clearing the active session', async () => {
  const first = sessions.saveConnection({ label: 'Atomic', serverUrl: 'https://atomic.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'atomic-old' });
  const owner = { serverUrl: first.serverUrl, siteContentUrl: '', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  sessions.setSession(owner, { connectionId: first.id, patSecret: 'old-secret' });
  const broker = { resolve: async () => 'new-secret', delete: async () => true };
  const app = Fastify(); await app.register(sensible);
  registerTableauRoutes(app, { credentialBroker: broker, discoverRestApiVersion: async () => '3.27', patSignin: async () => ({ token: 'token', siteId: 'site', userId: 'user' }), fetchImpl: async () => Response.json({ user: { id: 'user' } }) });
  getDb().exec(`CREATE TRIGGER fail_retirement BEFORE INSERT ON settings WHEN NEW.key LIKE 'tableauCredentialRetirement:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  try {
    const result = await app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload: { operationId: crypto.randomUUID(), storageKind: 'os', credentialRef: 'atomic-new', patName: 'fixture' } });
    assert.notEqual(result.statusCode, 200);
    assert.equal(sessions.getStoredConnection(first.id)?.credentialRef, 'atomic-old');
    assert.equal(sessions.getSession(), owner);
  } finally { getDb().exec('DROP TRIGGER fail_retirement'); await app.close(); }
});


test('replaying a committed replacement cannot undo a later replacement, even after database reopen', async () => {
  const secrets = new Map([['history-a', 'secret-a'], ['history-b', 'secret-b'], ['history-c', 'secret-c']]);
  const broker = { resolve: async (ref: string) => { const value = secrets.get(ref); if (!value) throw Error('missing'); return value; }, delete: async () => { throw Error('cleanup unavailable'); } };
  const makeApp = async () => { const app = Fastify(); await app.register(sensible); registerTableauRoutes(app, { credentialBroker: broker, discoverRestApiVersion: async () => '3.27', patSignin: async input => ({ token: input.patSecret, siteId: 'site', userId: 'user' }), fetchImpl: async () => Response.json({ user: { id: 'user' } }) }); return app; };
  const first = sessions.saveConnection({ label: 'History', serverUrl: 'https://history.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'os', credentialRef: 'history-a' });
  const op1 = crypto.randomUUID(), op2 = crypto.randomUUID();
  const body = (operationId: string, credentialRef: string) => ({ operationId, credentialRef, storageKind: 'os', patName: 'fixture' });
  let app = await makeApp();
  const put = (operationId: string, credentialRef: string) => app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload: body(operationId, credentialRef) });
  try {
    const a = await put(op1, 'history-b'); assert.equal(a.statusCode, 200); const ticket = a.json().retirement.ticket;
    assert.equal((await put(op2, 'history-c')).statusCode, 200);
    await app.close(); sessions.clearSession(); closeDb(); app = await makeApp();
    const replay = await put(op1, 'history-b');
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().superseded, true);
    assert.equal(replay.json().session, null);
    assert.equal(replay.json().retirement.ticket, ticket);
    assert.equal(sessions.getStoredConnection(first.id)?.credentialRef, 'history-c');
    const conflict = await put(op1, 'history-c'); assert.equal(conflict.statusCode, 409);
    const reconciliation = await app.inject({ method: 'POST', url: '/api/tableau/connections/reconcile', payload: { kind: 'replace', operationId: op1, connectionId: first.id, credentialRef: 'history-b' } });
    assert.equal(reconciliation.json().status, 'committed');
    assert.equal(reconciliation.json().superseded, true);
    assert.equal((await app.inject('/api/tableau/credential-retirements')).json().retirements.filter((item: { connectionId: string }) => item.connectionId === first.id).length, 2);
  } finally { await app.close(); }
});


test('encrypted replacement operation identifies different secrets without retaining them', async () => {
  const first = sessions.saveConnection({ label: 'Encrypted', serverUrl: 'https://encrypted.example.test', siteContentUrl: '', patName: 'fixture', storageKind: 'encrypted', patSecret: 'original-fixture-secret' });
  const app = Fastify(); await app.register(sensible);
  registerTableauRoutes(app, { discoverRestApiVersion: async () => '3.27', patSignin: async () => ({ token: 'token', siteId: 'site', userId: 'user' }), fetchImpl: async () => Response.json({ user: { id: 'user' } }) });
  const operationId = crypto.randomUUID();
  const put = (patSecret: string) => app.inject({ method: 'PUT', url: `/api/tableau/connections/${first.id}/credential`, payload: { operationId, storageKind: 'encrypted', explicitFallback: true, patName: 'fixture', patSecret } });
  try {
    assert.equal((await put('new-fixture-secret')).statusCode, 200);
    assert.equal((await put('new-fixture-secret')).statusCode, 200);
    assert.equal((await put('different-fixture-secret')).statusCode, 409);
    const values = getDb().prepare("SELECT value FROM settings WHERE key LIKE 'tableauCredentialReplacement:%'").all() as Array<{ value: string }>;
    assert.ok(values.every(item => !item.value.includes('new-fixture-secret') && !item.value.includes('different-fixture-secret')));
  } finally { await app.close(); }
});
