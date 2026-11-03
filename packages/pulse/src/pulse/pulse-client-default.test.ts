import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError } from '@pulse-metric-studio/core';
import { listMetricsInventory, resolveDefaultMetricId } from './pulse-client.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session: TableauSession = {
  serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site-id',
  userId: 'user-id', token: 'test-token', apiVersion: '3.27',
};
const monthToDate = { filters: [], measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' } };

test('publication resolves the month-to-date metric instead of assuming inventory order', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json({ metrics: [
      { id: 'year', specification: { measurement_period: { granularity: 'GRANULARITY_BY_YEAR', range: 'RANGE_CURRENT_PARTIAL' } } },
      { id: 'default', is_default: true, specification: monthToDate },
    ] });
  };
  assert.equal(await resolveDefaultMetricId(session, 'definition', 1), 'default');
});

test('publication verifies an identifier-only default through the read API', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.notEqual(init?.method, 'POST');
    urls.push(String(input));
    return Response.json(urls.length === 1 ? { metrics: [{ id: 'default' }] } : { metric: { id: 'default', specification: monthToDate } });
  };
  assert.equal(await resolveDefaultMetricId(session, 'definition', 1), 'default');
  assert.equal(urls.length, 2);
});

test('unexpected provider timeframe is reported without creating another metric', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.notEqual(init?.method, 'POST');
    return Response.json({ metrics: [{ id: 'default', is_default: true, specification: { measurement_period: { granularity: 'GRANULARITY_BY_YEAR', range: 'RANGE_CURRENT_PARTIAL' } } }] });
  };
  await assert.rejects(resolveDefaultMetricId(session, 'definition', 1), /initial metric is not month-to-date/);
});

for (const failure of ['permission', 'contract'] as const) {
  test(`a permanent ${failure} resolution failure stops before another poll`, async () => {
    let reads = 0;
    globalThis.fetch = async () => {
      reads++;
      return failure === 'permission'
        ? Response.json({ error: { summary: 'Permission denied' } }, { status: 403 })
        : Response.json({ metrics: null });
    };
    await assert.rejects(resolveDefaultMetricId(session, 'definition', 2), (error: unknown) => error instanceof TableauError && error.status === (failure === 'permission' ? 403 : 502));
    assert.equal(reads, 1);
  });
}

test('healthy empty reads after a transient failure retain pending visibility rather than a stale diagnostic', async () => {
  let reads = 0;
  globalThis.fetch = async () => ++reads === 1
    ? Response.json({ error: { summary: 'Temporarily unavailable' } }, { status: 503 })
    : Response.json({ metrics: [] });
  assert.equal(await resolveDefaultMetricId(session, 'definition', 2), null);
  assert.equal(reads, 2);
});

test('exhausted transient polling preserves the final provider status and diagnostic', async () => {
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({ error: { code: `50300${reads}`, summary: `Unavailable attempt ${reads}` } }, { status: 503 });
  };
  await assert.rejects(resolveDefaultMetricId(session, 'definition', 2), (error: unknown) => error instanceof TableauError && error.status === 503 && error.providerCode === '503002' && error.providerInfo?.summary === 'Unavailable attempt 2');
  assert.equal(reads, 2);
});

for (const initialStatus of [404, 503]) {
  test(`a retryable ${initialStatus} resolution read can recover to the actual default metric`, async () => {
    let reads = 0;
    globalThis.fetch = async () => ++reads === 1
      ? Response.json({ error: { summary: 'Not visible yet' } }, { status: initialStatus })
      : Response.json({ metrics: [{ id: 'default', is_default: true, specification: monthToDate }] });
    assert.equal(await resolveDefaultMetricId(session, 'definition', 2), 'default');
    assert.equal(reads, 2);
  });
}

test('a provider failure during pagination retains its status instead of becoming a generic contract error', async () => {
  let reads = 0;
  globalThis.fetch = async () => ++reads === 1
    ? Response.json({ metrics: [{ id: 'default', is_default: true, specification: monthToDate }], next_page_token: 'next' })
    : Response.json({ error: { code: '503006', summary: 'Next page unavailable' } }, { status: 503 });
  await assert.rejects(resolveDefaultMetricId(session, 'definition', 1), (error: unknown) => error instanceof TableauError && error.status === 503 && error.providerCode === '503006');
  assert.equal(reads, 2);
});

test('a successful response beyond the local body limit is a permanent resolution failure', async () => {
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({ metrics: [] }, { headers: { 'content-length': '999999999' } });
  };
  await assert.rejects(resolveDefaultMetricId(session, 'definition', 2), /permitted size/);
  assert.equal(reads, 1, 'the unchanged local size limit does not cause another provider poll');
});

test('a later-page size failure preserves the partial inventory but remains permanent for resolution', async () => {
  let reads = 0;
  globalThis.fetch = async () => ++reads % 2 === 1
    ? Response.json({ metrics: [{ id: 'default', is_default: true, specification: monthToDate }], next_page_token: 'next' })
    : Response.json({ metrics: [] }, { headers: { 'content-length': '999999999' } });
  const partial = await listMetricsInventory(session, 'definition');
  assert.equal(partial.metrics[0].id, 'default');
  assert.equal(partial.truncated, true);
  assert.match(partial.diagnostic?.message ?? '', /permitted size/);
  await assert.rejects(resolveDefaultMetricId(session, 'definition', 2), /permitted size/);
  assert.equal(reads, 4, 'resolution reads two pages once rather than replaying the inventory after a size failure');
});
