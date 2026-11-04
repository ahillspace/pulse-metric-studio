import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearSession, setSession, type TableauSession } from '@pulse-metric-studio/core';
import { resolveSourceCatalog, resolveSourceContext, type SourceDependencies } from './source-context.js';

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
    assert.notEqual(expired.id, first.id); assert.equal(calls.metric, 4); assert.equal(calls.definition, 2);
    setSession(session, { connectionId: 'connection', patSecret: '' });
    await assert.rejects(() => resolveSourceContext(session, ['a', 'b'], { sourceContextId: expired.id }, dependencies, dependencies), /unavailable for this session/);
    assert.equal(calls.metric, 4, 'An owner mismatch never acquires provider facts.');
  } finally { Date.now = originalNow; clearSession(); }
});
