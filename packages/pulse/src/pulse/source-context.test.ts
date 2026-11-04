import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearSession, setSession, TableauThrottleError, type TableauSession } from '@pulse-metric-studio/core';
import { resolveSourceCatalog, resolveSourceContext, type SourceDependencies } from './source-context.js';
import { PulseForkPlanService, type PulseForkPlanDependencies } from './fork-plan-service.js';

function sourceFixture(): { session: TableauSession; dependencies: SourceDependencies } {
  const session: TableauSession = { serverUrl: 'https://source.example.test', siteContentUrl: 'site', siteId: 'site', userId: 'source-user', token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  return { session, dependencies: {
    getMetric: async (_session, id) => ({ id, definition_id: 'definition', specification: { filters: [] } }),
    getDefinition: async () => ({ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: [] } }),
    getCatalog: async () => { throw new Error('Timeframe variants do not read a catalog.'); },
  } };
}

test('explicit fork retry reacquires a throttled source while preserving fresh good facts and handle identity', async () => {
  const { session, dependencies: source } = sourceFixture();
  const originalNow = Date.now; let now = 2_000_000; Date.now = () => now;
  const metricReads: Record<string, number> = {}; let definitionReads = 0, writes = 0;
  const dependencies: PulseForkPlanDependencies = { ...source,
    getMetric: async (session, id) => {
      metricReads[id] = (metricReads[id] ?? 0) + 1;
      if (id === 'b' && metricReads[id] === 1) throw new TableauThrottleError({ retryAt: now + 1000, serverTime: now, reason: 'throttle', sent: true });
      return source.getMetric(session, id);
    },
    getDefinition: async (session, id) => { definitionReads++; return source.getDefinition(session, id); },
    queryValues: async () => { throw new Error('No filtered validation.'); },
    getOrCreate: async () => { writes++; return { metricId: 'destination', created: true }; },
  };
  try {
    const first = await resolveSourceContext(session, ['a', 'b'], {}, dependencies, dependencies);
    assert.equal(first.failures.length, 1); assert.equal(writes, 0);
    const acquiredAt = first.sources[0]!.acquiredAt;
    now += 2000;
    const summary = await new PulseForkPlanService(dependencies).forkMetrics(session, { version: 1, sourceContextId: first.id, sourceMetricIds: ['a', 'b'], timeframe: { key: 'LAST_30_DAYS' }, clauses: [] });
    assert.equal(summary.failed, 0); assert.equal(summary.created, 1); assert.equal(summary.results.length, 2);
    assert.deepEqual(metricReads, { a: 1, b: 2 }); assert.equal(definitionReads, 2); assert.equal(writes, 1);
    const ready = await resolveSourceContext(session, ['b', 'a'], { sourceContextId: first.id }, dependencies, dependencies);
    assert.equal(ready.id, first.id); assert.equal(ready.failures.length, 0); assert.equal(ready.sources.find(source => source.metricId === 'a')!.acquiredAt, acquiredAt);
    assert.equal(ready.expiresAt, acquiredAt + 60_000);
    assert.deepEqual(metricReads, { a: 1, b: 2 });
    now = acquiredAt + 60_001;
    const refreshed = await resolveSourceContext(session, ['a', 'b'], { sourceContextId: ready.id }, dependencies, dependencies);
    assert.equal(refreshed.id, ready.id); assert.deepEqual(metricReads, { a: 2, b: 2 }); assert.equal(writes, 1);
    assert.equal(refreshed.sources.find(source => source.metricId === 'b')!.acquiredAt, acquiredAt + 2000);
  } finally { Date.now = originalNow; clearSession(); }
});

test('empty failed contexts retain usable handles but share missing-fact acquisition on explicit retry', async () => {
  const { session, dependencies: source } = sourceFixture();
  const originalNow = Date.now; let now = 3_000_000; Date.now = () => now;
  let metricReads = 0, release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const dependencies: SourceDependencies = { ...source, getMetric: async (session, id) => {
    metricReads++;
    if (metricReads === 1) throw new TableauThrottleError({ retryAt: now + 1000, serverTime: now, reason: 'throttle', sent: true });
    await held; return source.getMetric(session, id);
  } };
  try {
    const failed = await resolveSourceContext(session, ['a'], {}, dependencies, dependencies);
    assert.equal(failed.sources.length, 0); assert.equal(failed.failures.length, 1);
    now += 2000;
    const first = resolveSourceContext(session, ['a'], {}, dependencies, dependencies);
    const shared = resolveSourceContext(session, ['a'], { sourceContextId: failed.id }, dependencies, dependencies);
    assert.equal(metricReads, 2); release();
    const results = await Promise.all([first, shared]);
    assert.ok(results.every(context => context.id === failed.id && context.sources.length === 1 && context.failures.length === 0));
    assert.equal(metricReads, 2);
  } finally { release(); Date.now = originalNow; clearSession(); }
});

test('a ready source handle never waits for unrelated pending acquisition', async () => {
  const { session, dependencies: source } = sourceFixture();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const dependencies: SourceDependencies = { ...source, getMetric: async (session, id) => { if (id === 'a') await held; return source.getMetric(session, id); } };
  const a = resolveSourceContext(session, ['a'], {}, dependencies, dependencies);
  let lookup: ReturnType<typeof resolveSourceContext> | undefined;
  try {
    const b = await resolveSourceContext(session, ['b'], {}, dependencies, dependencies);
    lookup = resolveSourceContext(session, ['b'], { sourceContextId: b.id }, dependencies, dependencies);
    assert.equal(await Promise.race([lookup.then(() => true), new Promise<boolean>(resolve => setImmediate(() => resolve(false)))]), true);
  } finally { release(); await Promise.allSettled([a, ...(lookup ? [lookup] : [])]); clearSession(); }
});

test('source and catalog freshness preserve acquisition time, share pending facts and reject another owner', async () => {
  const originalNow = Date.now; let now = 1_000_000; Date.now = () => now;
  const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'user', token: 'token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'connection', patSecret: '' });
  const calls = { metric: 0, definition: 0, catalog: 0 };
  const dependencies: SourceDependencies = {
    getMetric: async (_session, id) => { calls.metric++; return { id, definition_id: 'definition', specification: {} }; },
    getDefinition: async () => { calls.definition++; return { metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } }, extension_options: { allowed_dimensions: [] } }; },
    getCatalog: async () => { calls.catalog++; return { datasourceLuid: 'datasource', datasourceName: 'Orders', dimensions: [], measures: [], timeDimensions: [], parameters: [], excluded: [], source: 'vds', warnings: [] }; },
  };
  try {
    const [first, shared] = await Promise.all([resolveSourceContext(session, ['a', 'b'], {}, dependencies, dependencies), resolveSourceContext(session, ['b', 'a'], {}, dependencies, dependencies)]);
    assert.equal(first.id, shared.id); assert.deepEqual(calls, { metric: 2, definition: 1, catalog: 0 });
    await Promise.all([resolveSourceCatalog(session, first, dependencies), resolveSourceCatalog(session, first, dependencies)]);
    assert.equal(calls.catalog, 1);
    const acquiredAt = first.sources[0]!.acquiredAt;
    now += 16_000; await resolveSourceCatalog(session, first, dependencies);
    assert.equal(calls.catalog, 2, 'Suspicious zero-time catalogs retain their shorter original TTL.');
    assert.equal(first.sources[0]!.acquiredAt, acquiredAt);
    now += 45_000;
    const expired = await resolveSourceContext(session, ['a', 'b'], { sourceContextId: first.id }, dependencies, dependencies);
    assert.equal(expired.id, first.id); assert.equal(calls.metric, 4); assert.equal(calls.definition, 2);
    await resolveSourceContext(session, ['b', 'a'], { sourceContextId: first.id }, dependencies, dependencies);
    assert.equal(calls.metric, 4, 'The browser keeps using its original handle after fact renewal.');
    setSession(session, { connectionId: 'connection', patSecret: '' });
    await assert.rejects(() => resolveSourceContext(session, ['a', 'b'], { sourceContextId: expired.id }, dependencies, dependencies), /unavailable for this session/);
    assert.equal(calls.metric, 4, 'An owner mismatch never acquires provider facts.');
  } finally { Date.now = originalNow; clearSession(); }
});

test('stable retained handles still fence selected sources, inventory views, bounded eviction, and owner changes', async () => {
  const { session, dependencies: source } = sourceFixture(); let reads = 0;
  const dependencies: SourceDependencies = { ...source, getMetric: async (session, id) => { reads++; return source.getMetric(session, id); } };
  try {
    const original = await resolveSourceContext(session, ['a'], {}, dependencies, dependencies);
    await assert.rejects(resolveSourceContext(session, ['b'], { sourceContextId: original.id }, dependencies, dependencies), /does not match selected metrics/);
    assert.equal(reads, 1);
    const newView = await resolveSourceContext(session, ['a'], { sourceContextId: original.id, snapshotId: 'different-inventory-view' }, dependencies, dependencies);
    assert.notEqual(newView.id, original.id); assert.equal(reads, 2, 'A new view acquires separate source facts.');
    let latest = newView;
    for (let index = 0; index < 8; index++) latest = await resolveSourceContext(session, [`other-${index}`], {}, dependencies, dependencies);
    const before = reads;
    await assert.rejects(resolveSourceContext(session, ['a'], { sourceContextId: original.id }, dependencies, dependencies), /unavailable for this session/);
    assert.equal(reads, before, 'Evicted handles never fall back to provider reads.');
    setSession(session, { connectionId: 'connection', patSecret: '' });
    await assert.rejects(resolveSourceContext(session, ['other-7'], { sourceContextId: latest.id }, dependencies, dependencies), /unavailable for this session/);
    assert.equal(reads, before);
  } finally { clearSession(); }
});
