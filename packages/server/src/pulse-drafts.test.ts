import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-drafts-composition-'));
const previousDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
const previousLogLevel = process.env.LOG_LEVEL;
let core: typeof import('@pulse-metric-studio/core');
let buildApp: typeof import('./app.js').buildApp;
let registerPulseRoutes: typeof import('@pulse-metric-studio/pulse').registerPulseRoutes;
let connectionId: string;
const draft = { version: 1, datasourceLuid: 'source-a', datasourceName: 'Orders', metrics: { sales: { name: 'Revenue' } }, chat: [{ role: 'user', content: 'Track revenue' }] };

before(async () => {
  process.env.PULSE_METRIC_STUDIO_DATA_DIR = dataDir;
  process.env.LOG_LEVEL = 'silent';
  core = await import('@pulse-metric-studio/core');
  ({ buildApp } = await import('./app.js'));
  ({ registerPulseRoutes } = await import('@pulse-metric-studio/pulse'));
  connectionId = core.saveConnection({ label: 'Draft test', serverUrl: 'https://tableau.example', siteContentUrl: 'sales', patName: 'test', patSecret: 'test-only', storageKind: 'encrypted' }).id;
  core.setSession({ serverUrl: 'https://tableau.example', siteContentUrl: 'sales', siteId: 'site-a', userId: 'user-a', token: 'test-only', apiVersion: '3.27' });
});

after(() => {
  core?.clearSession();
  core?.closeDb();
  if (previousDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = previousDataDir;
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('actual Pulse app registration persists a draft across server and database restart', async () => {
  let app = buildApp({ registerPulseRoutes });
  try {
    const saved = await app.inject({ method: 'PUT', url: '/api/drafts/source-a', payload: { draft } });
    assert.equal(saved.statusCode, 200, saved.body);
    await app.close();
    core.closeDb();
    app = buildApp({ registerPulseRoutes });
    const restored = await app.inject({ method: 'GET', url: '/api/drafts/source-a' });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().draft, draft);
    assert.equal(typeof restored.json().updatedAt, 'number');
  } finally {
    await app.close();
  }
});

test('pending saves keep their original connection and cannot overwrite another site draft', async () => {
  const app = buildApp({ registerPulseRoutes });
  const contextA = { connectionId, serverUrl: 'https://tableau.example', siteId: 'site-a' };
  core.saveConnection({ label: 'Other site', serverUrl: 'https://tableau.example', siteContentUrl: 'other', patName: 'test', patSecret: 'test-only', storageKind: 'encrypted' });
  core.setSession({ serverUrl: 'https://tableau.example', siteContentUrl: 'other', siteId: 'site-b', userId: 'user-b', token: 'test-only', apiVersion: '3.27' });
  try {
    const draftB = { ...draft, datasourceName: 'Different orders', chat: [] };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/drafts/source-a', payload: { draft: draftB } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/drafts/source-a', payload: { draft, context: contextA } })).statusCode, 200);
    const restoredB = await app.inject({ method: 'GET', url: '/api/drafts/source-a' });
    assert.deepEqual(restoredB.json().draft, draftB);
    const queryA = new URLSearchParams(contextA).toString();
    assert.equal((await app.inject({ method: 'GET', url: `/api/drafts/source-a?${queryA}` })).statusCode, 409);
    core.setActiveConnection(connectionId);
    core.setSession({ serverUrl: 'https://tableau.example', siteContentUrl: 'sales', siteId: 'site-a', userId: 'user-a', token: 'test-only', apiVersion: '3.27' });
    const restoredA = await app.inject({ method: 'GET', url: '/api/drafts/source-a' });
    assert.deepEqual(restoredA.json().draft, draft);
    const wrongSource = await app.inject({ method: 'PUT', url: '/api/drafts/source-b', payload: { draft } });
    assert.equal(wrongSource.statusCode, 400);
    const deleted = await app.inject({ method: 'DELETE', url: '/api/drafts/source-a' });
    assert.equal(deleted.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/drafts/source-a' })).statusCode, 404);
  } finally {
    await app.close();
  }
});
