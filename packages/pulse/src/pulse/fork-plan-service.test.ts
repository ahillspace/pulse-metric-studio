import {
clearSession,closeDb,config,setSession,
TableauError,
type TableauSession
} from '@pulse-metric-studio/core';
import { defaultPulseMetric, emptyPulseDocument, type DatasourceCatalog, type PulseDraftRecord } from '@pulse-metric-studio/shared';
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after,test } from 'node:test';
import {
canonicalizeForkPlanRequest,
forkPlanHttpStatus,
PulseForkPlanError,
PulseForkPlanService,
type PulseForkPlanDependencies,
type PulseForkPlanSummary
} from './fork-plan-service.js';
import { registerPulseRoutes } from './routes.js';
import { PulseDimensionalForkService } from './dimensional-fork-service.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-fork-plan-'));
config.dataDir = directory; config.dbPath = path.join(directory, 'test.db');
after(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

const catalog: DatasourceCatalog = {
  datasourceLuid: 'datasource-1',
  datasourceName: 'Orders',
  measures: [],
  dimensions: [
    field('field-region', 'Region'),
    field('field-category', 'Category'),
    field('field-segment', 'Segment'),
  ],
  timeDimensions: [],
  parameters: [],
  excluded: [],
  source: 'vds',
  warnings: [],
};

function field(id: string, name: string) {
  return {
    id,
    label: name,
    name,
    caption: name,
    role: 'DIMENSION' as const,
    dataType: 'STRING',
    table: 'Orders',
    defaultAggregation: null,
    formula: null,
    requiresUserAgg: false,
  };
}

function dependencies(overrides: Partial<PulseForkPlanDependencies> = {}): PulseForkPlanDependencies {
  return {
    getMetric: async (_session, metricId) => ({
      id: metricId,
      site_id: 'site-id',
      definition_id: 'definition-1',
      specification: {
        datasource: { id: '00000000-0000-0000-0000-000000000000' },
        filters: [
          {
            field: 'Region',
            operator: 'OPERATOR_EQUAL',
            categorical_values: [{ string_value: 'Old region' }],
            include_null: false,
          },
          {
            field: 'Segment',
            operator: 'OPERATOR_EQUAL',
            categorical_values: [{ string_value: 'Enterprise' }],
            include_null: false,
          },
        ],
        measurement_period: { granularity: 'GRANULARITY_BY_MONTH', range: 'RANGE_CURRENT_PARTIAL' },
        comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
        preserved: { enabled: true },
      },
    }),
    getDefinition: async () => ({
      metadata: { id: 'definition-1' },
      specification: { datasource: { id: 'datasource-1' } },
      extension_options: { allowed_dimensions: ['Region', 'Category', 'Segment'] },
    }),
    getCatalog: async () => structuredClone(catalog),
    queryValues: async (_session, input) => input.fieldName === 'Region'
      ? [['East'], ['West']]
      : [['Office Supplies'], ['Technology']],
    getOrCreate: async () => ({ metricId: 'fork-1', created: true }),
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: 'visible',
      exactMetricResolved: true,
      inventoryVisible: true,
      ownershipVerified: true,
      attempts: 1,
    }),
    ...overrides,
  };
}

test('builds one canonical combined specification per exact source metric', async () => {
  const requests: Array<{ definitionId: string; specification: Record<string, unknown> }> = [];
  const source = await dependencies().getMetric(session, 'metric-1');
  const deps = dependencies({
    getMetric: async () => source,
    getOrCreate: async (_session, input) => {
      requests.push(structuredClone(input));
      return { metricId: 'fork-1', created: true };
    },
  });

  const summary = await new PulseForkPlanService(deps).forkMetrics(session, {
    version: 1,
    sourceMetricIds: [' metric-1 ', 'metric-1'],
    timeframe: { key: 'LAST_30_DAYS' },
    clauses: [
      { fieldId: 'field-region', selection: { mode: 'VALUES', values: ['West', 'East', 'West'] } },
      { fieldId: 'field-category', selection: { mode: 'VALUES', values: ['Office Supplies'] } },
    ],
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    definitionId: 'definition-1',
    specification: {
      filters: [
        {
          field: 'Region',
          operator: 'OPERATOR_EQUAL',
          categorical_values: [{ string_value: 'East' }, { string_value: 'West' }],
          include_null: false,
        },
        {
          field: 'Segment',
          operator: 'OPERATOR_EQUAL',
          categorical_values: [{ string_value: 'Enterprise' }],
          include_null: false,
        },
        {
          field: 'Category',
          operator: 'OPERATOR_EQUAL',
          categorical_values: [{ string_value: 'Office Supplies' }],
          include_null: false,
        },
      ],
      measurement_period: {
        granularity: 'GRANULARITY_BY_DAY',
        range: 'RANGE_BY_CONFIG',
        last_x_period: {
          period: 30,
          period_type: 'GRANULARITY_BY_DAY',
          include_current_period: true,
        },
      },
      comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
      preserved: { enabled: true },
    },
  });
  assert.equal((source.specification?.datasource as { id: string }).id, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(summary, {
    attempted: 1,
    notAttempted: 0,
    created: 1,
    existing: 0,
    failed: 0,
    pendingVisibility: 0,
    results: [{
      sourceMetricId: 'metric-1',
      status: 'visible',
      creationStatus: 'created',
      reconciliationStatus: 'visible',
      metricId: 'fork-1',
      requestedSpecification: requests[0]!.specification,
    }],
  });
});

test('fork route waits for in-flight work after auth termination and preserves completed and unsent outcomes', async () => {
  let failAuth!: () => void;
  let finishInflight!: () => void;
  let completedA!: () => void;
  const authGate = new Promise<void>((resolve) => { failAuth = resolve; });
  const flightGate = new Promise<void>((resolve) => { finishInflight = resolve; });
  const aDone = new Promise<void>((resolve) => { completedA = resolve; });
  const started: string[] = [];
  const base = dependencies();
  const service = new PulseForkPlanService(dependencies({
    getMetric: async (session, id) => {
      const metric = await base.getMetric(session, id);
      return { ...metric, specification: { ...metric.specification, sourceKey: id } };
    },
    getOrCreate: async (_session, { specification }) => {
      const id = String(specification.sourceKey);
      started.push(id);
      if (id === 'b') { await authGate; throw new TableauError('Session ended', 401, '', 'auth'); }
      if (id !== 'a') await flightGate;
      return { metricId: `fork-${id}`, created: true };
    },
    reconcile: async (session, input) => {
      if (input.metricId === 'fork-a') completedA();
      return base.reconcile(session, input);
    },
  }));
  const app = Fastify();
  registerPulseRoutes(app, { forkPlanService: service });
  setSession(session, { connectionId: 'fork-settled-test', patSecret: 'test' });
  let settled = false;
  const response = app.inject({ method: 'POST', url: '/api/pulse/metrics/fork', payload: {
    context: { connectionId: 'fork-settled-test', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource-1' }, version: 1, sourceMetricIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], timeframe: { key: 'LAST_MONTH' }, clauses: [],
  } }).then((result) => { settled = true; return result; });
  try {
    await aDone;
    failAuth();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'response must await already-started work');
    assert.ok(!started.includes('g') && !started.includes('h'));
    const startedAtTermination = [...started];
    finishInflight();
    const reply = await response;
    assert.equal(reply.statusCode, 207, reply.body);
    const summary = reply.json() as PulseForkPlanSummary;
    assert.equal(summary.terminated, true);
    assert.deepEqual(started, startedAtTermination, 'no new mutations after termination');
    assert.equal(summary.results.length, 8);
    assert.equal(summary.results.find((item) => item.sourceMetricId === 'a')?.metricId, 'fork-a');
    assert.equal(summary.results.find((item) => item.sourceMetricId === 'c')?.metricId, 'fork-c');
    assert.equal(summary.results.find((item) => item.sourceMetricId === 'b')?.creationStatus, 'unknown');
    assert.equal(summary.results.find((item) => item.sourceMetricId === 'h')?.creationStatus, 'not_attempted');
  } finally {
    failAuth(); finishInflight(); await response; await app.close(); clearSession();
  }
});

test('fork preserves a confirmed metric when reconciliation throws terminal authentication', async () => {
  const summary = await new PulseForkPlanService(dependencies({
    reconcile: async () => { throw new TableauError('Expired during reconciliation', 401, '', 'auth'); },
  })).forkMetrics(session, { version: 1, sourceMetricIds: ['a'], timeframe: { key: 'LAST_MONTH' }, clauses: [] });
  assert.equal(summary.results[0]?.metricId, 'fork-1');
  assert.equal(summary.results[0]?.creationStatus, 'created');
  assert.equal(summary.results[0]?.reconciliationStatus, 'failed');
  assert.equal(summary.created, 1);
  assert.equal(summary.terminated, true);
  assert.equal(forkPlanHttpStatus(summary), 207);
});

test('date-only plans do not require dimensional metadata', async () => {
  let catalogCalls = 0;
  const summary = await new PulseForkPlanService(dependencies({
    getDefinition: async () => ({
      metadata: { id: 'definition-1' },
      specification: { datasource: { id: 'datasource-1' } },
    }),
    getCatalog: async () => {
      catalogCalls++;
      return structuredClone(catalog);
    },
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['metric-1'],
    timeframe: { key: 'LAST_30_DAYS' },
    clauses: [],
  });

  assert.equal(catalogCalls, 0);
  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.results[0]?.creationStatus, 'created');
  assert.equal(summary.results[0]?.reconciliationStatus, 'visible');
});

test('rejects a stale domain value before any get-or-create request', async () => {
  let createCalls = 0;
  const summary = await new PulseForkPlanService(dependencies({
    getOrCreate: async () => {
      createCalls++;
      return { metricId: 'fork-1', created: true };
    },
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['metric-1'],
    clauses: [{ fieldId: 'field-region', selection: { mode: 'VALUES', values: ['Missing'] } }],
  });

  assert.equal(createCalls, 0);
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0]!.error ?? '', /current domain/);
  assert.equal(forkPlanHttpStatus(summary), 422);
});

test('preserves partial results when one exact source cannot resolve', async () => {
  const summary = await new PulseForkPlanService(dependencies({
    getMetric: async (_session, metricId) => {
      if (metricId === 'metric-bad') throw new Error('Exact source metric is unavailable.');
      return dependencies().getMetric(session, metricId);
    },
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: 'pending_visibility',
      exactMetricResolved: true,
      inventoryVisible: false,
      ownershipVerified: true,
      attempts: 5,
    }),
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['metric-good', 'metric-bad'],
    timeframe: { key: 'LAST_7_DAYS' },
    clauses: [],
  });

  assert.equal(summary.attempted, 2);
  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pendingVisibility, 1);
  assert.deepEqual(summary.results.map((result) => result.status), ['failed', 'pending_visibility']);
  assert.equal(summary.results[1]?.creationStatus, 'created');
  assert.equal(summary.results[1]?.reconciliationStatus, 'pending_visibility');
  assert.equal(forkPlanHttpStatus(summary), 207);
});

test('preserves creation disposition when reconciliation rejects a returned metric', async () => {
  const summary = await new PulseForkPlanService(dependencies({
    getOrCreate: async () => ({ metricId: 'fork-1', created: false }),
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: 'ownership_mismatch',
      exactMetricResolved: true,
      inventoryVisible: false,
      ownershipVerified: false,
      attempts: 1,
      diagnostic: { message: 'Metric belongs to another definition.' },
    }),
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['metric-1'],
    timeframe: { key: 'LAST_30_DAYS' },
    clauses: [],
  });

  assert.equal(summary.existing, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0]?.status, 'ownership_mismatch');
  assert.equal(summary.results[0]?.creationStatus, 'existing');
  assert.equal(summary.results[0]?.reconciliationStatus, 'ownership_mismatch');
});

test('classifies a complete provider failure as 502', async () => {
  const summary = await new PulseForkPlanService(dependencies({
    getOrCreate: async () => {
      throw new TableauError('Provider rejected the request.', 400, 'invalid specification');
    },
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['metric-1'],
    timeframe: { key: 'LAST_30_DAYS' },
    clauses: [],
  });

  assert.equal(summary.failed, 1);
  assert.equal(forkPlanHttpStatus(summary), 502);
  assert.match(summary.results[0]!.error ?? '', /invalid specification/);
});

test('validates and canonicalizes the combined request', () => {
  assert.deepEqual(canonicalizeForkPlanRequest({
    version: 1,
    sourceMetricIds: ['metric-2', ' metric-1 ', 'metric-2'],
    clauses: [
      { fieldId: 'field-region', selection: { mode: 'VALUES', values: ['West'] } },
      { fieldId: 'field-region', selection: { mode: 'VALUES', values: ['East'] } },
    ],
  }), {
    version: 1,
    sourceMetricIds: ['metric-1', 'metric-2'],
    clauses: [{
      fieldId: 'field-region',
      selection: { mode: 'VALUES', exclude: false, values: ['East', 'West'] },
    }],
  });
  assert.throws(
    () => canonicalizeForkPlanRequest({ version: 1, sourceMetricIds: ['metric-1'], clauses: [] }),
    (error: unknown) => error instanceof PulseForkPlanError && error.statusCode === 400,
  );
});

test('combined route retains the canonical summary on a non-2xx response', async () => {
  const expected: PulseForkPlanSummary = {
    attempted: 1,
    created: 0,
    existing: 0,
    failed: 1,
    pendingVisibility: 0,
    results: [{
      sourceMetricId: 'metric-1',
      status: 'failed',
      requestedSpecification: {},
      error: 'Source metric failed validation.',
    }],
  };
  let received: unknown;
  const app = Fastify({ logger: false });
  setSession(session, { connectionId: 'fork-settled-test', patSecret: 'test' });
  registerPulseRoutes(app, {
    forkPlanService: {
      forkMetrics: async (_session, input) => {
        received = input;
        return expected;
      },
    },
  });
  try {
    const payload = { context: { connectionId: 'fork-settled-test', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource-1' }, version: 1, sourceMetricIds: ['metric-1'], timeframe: { key: 'LAST_30_DAYS' }, clauses: [] };
    const response = await app.inject({ method: 'POST', url: '/api/pulse/metrics/fork', payload });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(received, payload);
    assert.deepEqual(response.json(), expected);
  } finally {
    clearSession();
    await app.close();
  }
});



test('canonical planner handles more than one hundred sources with bounded provider concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const service = new PulseForkPlanService(dependencies({
    getOrCreate: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { metricId: 'bounded-result', created: true };
    },
  }));
  const result = await service.forkMetrics(session, {
    version: 1,
    sourceMetricIds: Array.from({ length: 125 }, (_, index) => `source-${index}`),
    timeframe: { key: 'LAST_30_DAYS' }, clauses: [],
  });
  assert.equal(result.attempted, 125);
  assert.equal(result.created, 125);
  assert.ok(maximum <= 5);
});

test('dimension routes read every source from POST bodies and reject invalid input before provider calls', async () => {
  let metricReads = 0;
  const base = dependencies();
  const service = new PulseDimensionalForkService({
    ...base,
    getMetric: async (owner, metricId) => { metricReads++; return base.getMetric(owner, metricId); },
    queryCount: async () => 2,
  });
  const app = Fastify();
  registerPulseRoutes(app, { dimensionalForkService: service });
  setSession(session, { connectionId: 'dimension-post-test', patSecret: 'test' });
  const sourceMetricIds = Array.from({ length: 1000 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
  try {
    for (const [url, input] of [
      ['/api/pulse/dimensions', {}],
      ['/api/pulse/dimensions/count', { fieldId: 'field-region' }],
      ['/api/pulse/dimensions/values', { fieldId: 'field-region', search: 'West', all: true }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload: { sourceMetricIds, ...input } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    }
    assert.equal(metricReads, 3000);
    for (const payload of [{ sourceMetricIds: [] }, { sourceMetricIds: [null] }, { sourceMetricIds: ['x'.repeat(513)] }]) {
      const response = await app.inject({ method: 'POST', url: '/api/pulse/dimensions', payload });
      assert.equal(response.statusCode, 400, response.body);
    }
    const invalidValues = await app.inject({ method: 'POST', url: '/api/pulse/dimensions/values', payload: { sourceMetricIds: ['metric'], fieldId: 'field-region', search: 'x'.repeat(257) } });
    assert.equal(invalidValues.statusCode, 400, invalidValues.body);
    assert.equal(metricReads, 3000);
  } finally { clearSession(); await app.close(); }
});

test('deletion accepts reordered metrics but rejects a changed metric specification', async () => {
  let reversed = false;
  let changed = false;
  let deletes = 0;
  const app = Fastify();
  const context = { connectionId: 'delete-order-test', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: 'datasource-1' };
  registerPulseRoutes(app, { deletion: {
    inventory: async () => ({ totalScanned: 1, truncated: false, failures: [], definitions: [{
      definitionId: 'definition', name: 'Sales', description: '', measure: 'Sales', aggregation: 'SUM', timeDimension: 'Date', inventoryStatus: 'complete',
      metrics: (reversed ? ['b', 'a'] : ['a', 'b']).map(metricId => ({ metricId, name: metricId, measurementPeriod: {}, timeframeLabel: 'Custom', filters: [], comparison: {}, isDefault: false, isScoped: false, scopedState: 'variant', specification: { comparison: changed && metricId === 'a' ? 'changed' : 'original' } })),
    }] }),
    execute: async () => { deletes++; return { definitionsDeleted: 1, metricsDeleted: 0, failures: [], outcomes: [] }; },
  } });
  setSession(session, { connectionId: context.connectionId, patSecret: 'test' });
  const selection = { context, definitionIds: ['definition'], metricIds: [] };
  try {
    const preview = await app.inject({ method: 'POST', url: '/api/pulse/registry/delete-preview', payload: selection });
    assert.equal(preview.statusCode, 200, preview.body);
    reversed = true;
    const accepted = await app.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    changed = true;
    const rejected = await app.inject({ method: 'POST', url: '/api/pulse/registry/delete', payload: { ...selection, previewFingerprint: preview.json().previewFingerprint } });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().code, 'delete_plan_changed');
    assert.equal(deletes, 1);
  } finally { clearSession(); await app.close(); }
});

test('draft and proposal routes preserve prototype-named fields through validated JSON documents', async () => {
  const fields: DatasourceCatalog = {
    ...catalog,
    measures: ['__proto__', 'constructor'].map(id => ({ ...field(id, id), role: 'MEASURE', dataType: 'REAL' })),
  };
  const document = emptyPulseDocument();
  document.metrics = Object.fromEntries([['__proto__', defaultPulseMetric(fields, '__proto__')!]]);
  const app = Fastify();
  app.post('/outside-workflow', async () => ({ ok: true }));
  registerPulseRoutes(app, {
    catalog: async () => fields,
    propose: async () => ({ assistantMessage: 'Configured both fields', ops: [
      { op: 'ADD_METRIC', fieldId: 'constructor', name: 'Constructor metric' },
      { op: 'MODIFY_METRIC', fieldId: '__proto__', name: 'Prototype metric' },
    ] }),
  });
  const context = { connectionId: 'prototype-route-test', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: fields.datasourceLuid };
  setSession(session, { connectionId: context.connectionId, patSecret: 'test' });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/pulse/drafts', payload: { context, datasourceName: 'Prototype fields', document } });
    assert.equal(created.statusCode, 200, created.body);
    const record = created.json<PulseDraftRecord>();
    assert.equal(Object.hasOwn(record.document.metrics, '__proto__'), true);
    record.document.metrics.__proto__!.description = 'Saved before the proposal';
    const saved = await app.inject({ method: 'PUT', url: `/api/pulse/drafts/${record.id}`, payload: { expectedRevision: record.revision, document: record.document } });
    assert.equal(saved.statusCode, 200, saved.body);
    const current = saved.json<PulseDraftRecord>();
    const proposed = await app.inject({ method: 'POST', url: `/api/pulse/drafts/${record.id}/proposals`, payload: { baseRevision: current.revision, document: current.document, message: 'Configure both fields' } });
    assert.equal(proposed.statusCode, 200, proposed.body);
    const candidate = proposed.json().candidateDocument;
    assert.equal(Object.hasOwn(candidate.metrics, '__proto__'), true);
    assert.equal(Object.hasOwn(candidate.metrics, 'constructor'), true);
    assert.equal(candidate.metrics.__proto__.name, 'Prototype metric');
    assert.equal(candidate.metrics.__proto__.description, 'Saved before the proposal');
    assert.equal(candidate.metrics.constructor.name, 'Constructor metric');
    const accepted = await app.inject({ method: 'PUT', url: `/api/pulse/drafts/${record.id}`, payload: { expectedRevision: current.revision, document: candidate } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json().document.metrics, candidate.metrics);
    const invalid = await app.inject({ method: 'PUT', url: `/api/pulse/drafts/${record.id}`, payload: { expectedRevision: accepted.json().revision, document: { ...candidate, metrics: [] } } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().code, 'invalid_request');
    const outside = await app.inject({ method: 'POST', url: '/outside-workflow', payload: { document: candidate } });
    assert.equal(outside.statusCode, 400, outside.body);
    assert.equal(outside.json().code, 'FST_ERR_CTP_INVALID_JSON_BODY');
    const poisoned = structuredClone(candidate);
    poisoned.metrics.constructor.prototype = { polluted: true };
    const rejected = await app.inject({ method: 'PUT', url: `/api/pulse/drafts/${record.id}`, payload: { expectedRevision: accepted.json().revision, document: poisoned } });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().code, 'FST_ERR_CTP_INVALID_JSON_BODY');
  } finally { clearSession(); await app.close(); }
});
