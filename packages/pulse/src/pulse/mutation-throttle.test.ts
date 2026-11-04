import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableauThrottleError, type TableauSession } from '@pulse-metric-studio/core';
import { PulseForkPlanService, forkPlanHttpStatus, type PulseForkPlanDependencies } from './fork-plan-service.js';
import { executeDeletes } from '../application/delete-execution.js';
const session: TableauSession = { serverUrl: 'https://example.test', siteContentUrl: 'site', siteId: 'site', userId: 'throttle-user', token: 'token', apiVersion: '3.27' };
const throttle = { retryAt: 100000, serverTime: 50000, reason: 'throttle' as const, sent: false };
function dependencies(): PulseForkPlanDependencies { return {
  getMetric: async (_session, id) => ({ id, definition_id: 'definition', specification: {} }),
  getDefinition: async () => ({ metadata: { id: 'definition' }, specification: { datasource: { id: 'datasource' } } }),
  getCatalog: async () => { throw new Error('Unexpected catalog'); }, queryValues: async () => [],
  getOrCreate: async () => { throw new TableauThrottleError(throttle); },
}; }
test('all-unsent create after command admission returns 429 with per-destination throttle timing', async () => {
  const summary = await new PulseForkPlanService(dependencies()).forkMetrics(session, { version: 1, sourceMetricIds: ['source'], timeframe: { key: 'LAST_MONTH' }, clauses: [] });
  assert.equal(forkPlanHttpStatus(summary), 429);
  assert.equal(summary.results[0]!.creationStatus, 'not_attempted');
  assert.deepEqual(summary.results[0]!.throttle, throttle);
  assert.equal(summary.results[0]!.sent, false);
});
test('delete stops unsent groups and retains exact throttle metadata', async () => {
  let calls = 0;
  const result = await executeDeletes(session, Array.from({ length: 8 }, (_, index) => ({ metricIds: [`metric-${index}`], name: 'metric' })), {
    deleteDefinition: async () => assert.fail('Unexpected definition delete'),
    deleteMetric: async () => { calls++; throw new TableauThrottleError(throttle); },
  });
  assert.ok(calls <= 5);
  assert.ok(result.outcomes.every(outcome => outcome.status === 'not_attempted' && outcome.sent === false));
  assert.ok(result.outcomes.every(outcome => outcome.throttle?.retryAt === throttle.retryAt));
});
