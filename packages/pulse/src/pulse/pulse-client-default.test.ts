import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TableauSession } from '@pulse-metric-studio/core';
import { resolveDefaultMetricId } from './pulse-client.js';

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
