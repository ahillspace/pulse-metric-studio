import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'pulse-local-throttle-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = dataDir;
const { assertTableauMutationAdmission, clearSession, closeDb, getSessionContext, saveConnection, setSession, tableauFetch } = await import('@pulse-metric-studio/core');
const { buildApp } = await import('./app.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

test('local cooldown status is owner fenced, performs zero Tableau calls, and keeps successful polls quiet', async () => {
  const session = { serverUrl: 'https://fixture.example.test', siteContentUrl: '', siteId: 'site', userId: 'user', token: 'PRIVATE_TOKEN', apiVersion: '3.27' };
  const connection = saveConnection({ label: 'Fixture', serverUrl: session.serverUrl, siteContentUrl: '', patName: 'fixture', patSecret: 'PRIVATE_SECRET', storageKind: 'encrypted' });
  setSession(session, { connectionId: connection.id, patSecret: 'PRIVATE_SECRET' });
  const context = getSessionContext(session)!;
  const owner = { connectionId: context.connectionId, serverUrl: session.serverUrl, siteId: session.siteId, userId: session.userId, sessionGeneration: context.generation };
  let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({}, { status: 429, headers: { 'retry-after': '36' } }); };
  const lines: string[] = [];
  const app = buildApp({ registerPulseRoutes(instance) {
    instance.post('/api/pulse/metrics/fixture', async () => { assertTableauMutationAdmission(session); return {}; });
  } }, { logStream: { write: line => { lines.push(line); } } });
  try {
    await tableauFetch(session, '/api/-/pulse/metrics/fixture', { timeoutMs: 100 });
    for (let i = 0; i < 3; i++) {
      const response = await app.inject(`/api/tableau/throttle?expectedOwner=${encodeURIComponent(JSON.stringify(owner))}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      const status = response.json();
      assert.deepEqual(Object.keys(status).sort(), ['reason', 'retryAt', 'serverTime', 'throttled']);
      assert.equal(status.throttled, true);
      assert.equal(status.reason, 'throttle');
      assert.ok(status.retryAt >= status.serverTime + 35_000);
    }
    const completions = () => lines.flatMap(line => line.trim().split('\n').map(entry => JSON.parse(entry))).filter(event => event.event === 'app.request');
    assert.equal(completions().length, 0);
    for (const changed of [{ connectionId: 'other' }, { serverUrl: 'https://other.example.test' }, { siteId: 'other' }, { userId: 'other' }, { sessionGeneration: context.generation + 1 }]) {
      const response = await app.inject(`/api/tableau/throttle?expectedOwner=${encodeURIComponent(JSON.stringify({ ...owner, ...changed }))}`);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, 'tableau_context_changed');
    }
    assert.equal((await app.inject('/api/tableau/throttle?expectedOwner=PRIVATE_INVALID')).statusCode, 400);
    const refusal = await app.inject({ method: 'POST', url: '/api/pulse/metrics/fixture' });
    assert.equal(refusal.statusCode, 429);
    assert.equal(refusal.json().sent, false);
    assert.equal(refusal.json().throttle.sent, false);
    assert.equal(refusal.json().throttle.reason, 'throttle');
    assert.ok(completions().some(event => event.path === '/api/tableau/throttle' && event.status === 409));
    assert.equal(sends, 1, 'polling, stale-owner rejection and command admission never contact Tableau');
    clearSession();
    assert.equal((await app.inject('/api/tableau/throttle')).statusCode, 401);
    assert.doesNotMatch(lines.join(''), /PRIVATE_/);
  } finally { await app.close(); }
});
