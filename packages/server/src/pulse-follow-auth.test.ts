import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearSession, closeDb, config, saveConnection, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { registerPulseRoutes } from '@pulse-metric-studio/pulse';
import { buildApp } from './app.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-follow-auth-'));
config.dataDir = directory;
config.dbPath = path.join(directory, 'test.db');
config.machineKeyPath = path.join(directory, 'machine.key');
config.logLevel = 'silent';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearSession(); });
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

test('follow details propagate revoked authentication after memberships were cached and stop remaining metric reads', async () => {
  const session: TableauSession = { serverUrl: 'https://tableau.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'test-only-token', apiVersion: '3.27' };
  const connection = saveConnection({ id: 'connection', label: 'Test connection', serverUrl: session.serverUrl, siteContentUrl: 'site', patName: 'test-pat', storageKind: 'encrypted', patSecret: 'test-only-secret' });
  setSession(session, { connectionId: connection.id, patSecret: 'test-only-secret' });
  const requests: string[] = [];
  let revoked = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, session.serverUrl, 'all provider calls remain in this isolated fake');
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/auth/signin')) return Response.json({ error: 'PAT rejected' }, { status: 401 });
    if (revoked) return Response.json({ error: 'Session token revoked' }, { status: 401 });
    if (url.pathname.endsWith('/users/user/groups')) return Response.json({ groups: { group: [{ id: 'group', name: 'Team' }] } });
    if (url.pathname.endsWith('/definitions')) return Response.json({ definitions: ['a', 'b'].map(id => ({ metadata: { id, name: id }, specification: { datasource: { id: 'ds' } } })) });
    const definitionId = /\/definitions\/([ab])\/metrics$/.exec(url.pathname)?.[1];
    if (definitionId) return Response.json({ metrics: (definitionId === 'a' ? ['a-1'] : ['b-1', 'b-2']).map(id => ({ id, is_default: id.endsWith('-1') })) });
    const metricId = /\/metrics\/([ab]-\d)$/.exec(url.pathname)?.[1];
    if (metricId) return Response.json({ metric: { id: metricId, definition_id: metricId[0], is_default: metricId.endsWith('-1'), specification: { measurement_period: {}, filters: [], comparison: {} } } });
    // Nonzero counts, so detail reads cannot settle from the count alone.
    if (url.pathname.endsWith('subscriptions:batchGetMetricFollowerCounts')) return Response.json({ counts: url.searchParams.get('metric_ids')!.split(',').map(id => ({ metric_id: id, count: 1 })) });
    assert.ok(url.pathname.endsWith('/subscriptions'), url.pathname);
    return Response.json({ subscriptions: [] });
  };
  const server = buildApp({ registerPulseRoutes });
  try {
    const inventory = await server.inject('/api/pulse/existing-metrics?datasourceLuid=ds');
    assert.equal(inventory.statusCode, 200, inventory.body);
    const snapshotId = inventory.json().snapshotId;
    const counts = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['a-1', 'b-1', 'b-2'], snapshotId, detail: false } });
    assert.equal(counts.statusCode, 200, counts.body);
    const first = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['a-1'], snapshotId, detail: true } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(requests.filter(url => url.includes('/users/user/groups')).length, 1);
    revoked = true;
    const before = requests.length;
    const details = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['b-1', 'b-2'], snapshotId, detail: true } });
    const detailRequests = requests.slice(before);
    const revokedCounts = await server.inject({ method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['b-1'], snapshotId, detail: false } });
    assert.equal(revokedCounts.statusCode, 401, 'count summary is the existing authentication control');
    assert.equal(details.statusCode, 401, details.body);
    assert.deepEqual(detailRequests.map(url => url.split('?')[0]), ['/api/-/pulse/subscriptions:batchGetMetricFollowerCounts', '/api/3.27/auth/signin'], 'typed auth from the count read stops the batch before any subscription read and does not repeat cached memberships or site discovery');
  } finally { await server.close(); }
});
