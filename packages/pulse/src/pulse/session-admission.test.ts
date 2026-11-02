import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TableauSession } from '@pulse-metric-studio/core';

const dataDir = mkdtempSync(join(tmpdir(), 'pulse-session-admission-'));
process.env.PULSE_METRIC_STUDIO_DATA_DIR = dataDir;
const { clearSession, closeDb, getSessionContext, setSession } = await import('@pulse-metric-studio/core');
const { registerPulseRoutes } = await import('./routes.js');
test.after(() => { clearSession(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

const session = (): TableauSession => ({ serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' });
function owner(current: TableauSession) {
  const context = getSessionContext(current)!;
  return { connectionId: context.connectionId, sessionGeneration: context.generation, serverUrl: current.serverUrl, siteId: current.siteId, userId: current.userId };
}
const owned = (url: string, expectedOwner: unknown) => `${url}${url.includes('?') ? '&' : '?'}expectedOwner=${encodeURIComponent(JSON.stringify(expectedOwner))}`;

test('queued registry reads and mutations reject a replacement backend owner before provider work', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; clearSession(); });
  const requests = [
    { method: 'GET', url: '/api/pulse/existing-metrics?datasourceLuid=source' },
    { method: 'GET', url: '/api/pulse/follow-targets' },
    { method: 'POST', url: '/api/pulse/follow-state', payload: { metricIds: ['metric'], detail: false } },
    { method: 'POST', url: '/api/pulse/followers-detail', payload: { metricIds: ['metric'] } },
    { method: 'POST', url: '/api/pulse/dimensions', payload: { sourceMetricIds: ['metric'] } },
    { method: 'POST', url: '/api/pulse/metrics/fork', payload: { version: 1, context: { connectionId: 'connection', serverUrl: 'https://example.test', siteId: 'site', datasourceLuid: 'source' }, sourceMetricIds: ['metric'], timeframe: { key: 'LAST_MONTH' }, clauses: [] } },
    ...['follow', 'unfollow'].map((action) => ({ method: 'POST', url: `/api/pulse/${action}`, payload: { context: { connectionId: 'connection', serverUrl: 'https://example.test', siteId: 'site', datasourceLuid: 'source' }, operations: [{ metricId: 'metric', target: { kind: 'USER', id: 'recipient' } }] } })),
  ] as const;
  for (const input of requests) {
    const first = session();
    setSession(first, { connectionId: 'connection', patSecret: '' });
    const captured = owner(first);
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const queue = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    globalThis.fetch = async () => { providerCalls++; throw new Error('Unexpected provider work'); };
    const app = Fastify();
    app.addHook('preHandler', async () => { started(); await queue; });
    registerPulseRoutes(app, {
      forkPlanService: { forkMetrics: async () => { providerCalls++; return { attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }; } },
      dimensionalForkService: { listEligibleDimensions: async () => { providerCalls++; return { fields: [] }; }, countDimensionMembers: async () => ({ fieldId: 'region', count: 0 }), listDimensionValues: async () => ({ fieldId: 'region', values: [], truncated: false }) },
    });
    try {
      const request = app.inject({ ...input, method: input.method as 'GET' | 'POST', url: owned(input.url, captured) });
      void request.then(() => {});
      await dispatched;
      setSession({ ...first, userId: 'replacement' }, { connectionId: 'connection', patSecret: '' });
      release();
      const response = await request;
      assert.equal(response.statusCode, 409, `${input.url}: ${response.body}`);
      assert.equal(response.json().code, 'tableau_context_changed');
      assert.equal(providerCalls, 0, input.url);
    } finally { release(); clearSession(); await app.close(); }
  }
});

test('expected owner compares every backend coordinate and omission retains legacy compatibility', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; clearSession(); });
  const current = session();
  setSession(current, { connectionId: 'connection', patSecret: '' });
  const expected = owner(current);
  let reads = 0;
  globalThis.fetch = async () => { reads++; return Response.json({ follower_counts: [{ metric_id: 'metric', follower_count: 1 }] }); };
  const app = Fastify();
  registerPulseRoutes(app);
  try {
    for (const change of [{ connectionId: 'other' }, { serverUrl: 'https://other.example.test' }, { siteId: 'other' }, { userId: 'other' }, { sessionGeneration: expected.sessionGeneration + 1 }]) {
      const response = await app.inject({ method: 'POST', url: owned('/api/pulse/follow-state', { ...expected, ...change }), payload: { metricIds: ['metric'], detail: false } });
      assert.equal(response.statusCode, 409, response.body);
    }
    assert.equal(reads, 0);
    for (const url of [owned('/api/pulse/follow-state', expected), '/api/pulse/follow-state']) {
      const response = await app.inject({ method: 'POST', url, payload: { metricIds: ['metric'], detail: false } });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(reads, 2);
    const malformed = await app.inject({ method: 'POST', url: owned('/api/pulse/follow-state', { connectionId: 'connection' }), payload: { metricIds: ['metric'], detail: false } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(reads, 2);
  } finally { await app.close(); }
});
