import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TableauError, type TableauSession } from '@pulse-metric-studio/core';
import {
  DIMENSIONAL_FORK_LIMITS,
  DIMENSION_VALUE_FETCH_CEILING,
  canonicalizeDimensionalForkRequest,
  type CatalogField,
  type DatasourceCatalog,
} from '@pulse-metric-studio/shared';
import {
  PulseDimensionalForkService,
  dimensionalForkHttpStatus,
  fingerprintValues,
  mergePulseStringFilter,
  type PulseDimensionalForkDependencies,
} from './dimensional-fork-service.js';
import type { PulseDefinition, PulseExactMetric } from './pulse-client.js';
import { repeatedQueryValues } from './routes.js';

const session: TableauSession = {
  serverUrl: 'https://example.test',
  siteContentUrl: 'site',
  siteId: 'site-id',
  userId: 'user-id',
  token: 'token',
  apiVersion: '3.27',
};

function dimension(name: string, dataType = 'STRING', table: string | null = 'Orders'): CatalogField {
  return {
    id: name,
    name,
    label: name,
    caption: name,
    role: 'DIMENSION',
    dataType,
    table,
    defaultAggregation: null,
    formula: null,
    requiresUserAgg: false,
  };
}

function catalog(fields: CatalogField[]): DatasourceCatalog {
  return {
    datasourceLuid: 'ds-1',
    datasourceName: 'Sales',
    measures: [],
    dimensions: fields,
    timeDimensions: [],
    parameters: [],
    excluded: [],
    source: 'vds',
    warnings: [],
  };
}

function dependencies(overrides: Partial<PulseDimensionalForkDependencies> = {}): PulseDimensionalForkDependencies {
  const metrics: Record<string, PulseExactMetric> = {
    m1: {
      id: 'm1',
      definition_id: 'd1',
      specification: {
        filters: [{ field: 'Segment', operator: 'OPERATOR_EQUAL', categorical_values: [{ string_value: 'Consumer' }] }],
        measurement_period: { granularity: 'GRANULARITY_MONTH' },
        comparison: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' },
      },
    },
    m2: {
      id: 'm2',
      definition_id: 'd2',
      specification: {
        filters: [],
        measurement_period: { granularity: 'GRANULARITY_WEEK' },
        comparison: { comparison: 'TIME_COMPARISON_YEAR_AGO_PERIOD' },
      },
    },
  };
  const definitions: Record<string, PulseDefinition> = {
    d1: {
      specification: { datasource: { id: 'ds-1' } },
      extension_options: { allowed_dimensions: ['Region', 'Category', 'Duplicate'] },
    },
    d2: {
      specification: { datasource: { id: 'ds-1' } },
      extension_options: { allowed_dimensions: ['Region', 'Duplicate'] },
    },
  };
  return {
    getMetric: async (_session, metricId) => structuredClone(metrics[metricId]!),
    getDefinition: async (_session, definitionId) => structuredClone(definitions[definitionId]!),
    getCatalog: async () => catalog([
      dimension('Region'),
      dimension('Category'),
      dimension('Order Date', 'DATE'),
      dimension('Duplicate', 'STRING', 'Orders'),
      dimension('Duplicate', 'STRING', 'Returns'),
    ]),
    queryValues: async () => [['West'], ['Central']],
    queryCount: async () => 2,
    getOrCreate: async (_session, input) => ({ metricId: input.definitionId, created: true }),
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

test('canonical request preserves provider spelling while removing exact duplicates', () => {
  const request = canonicalizeDimensionalForkRequest({
    version: 1,
    sourceMetricIds: ['m2', 'm1', 'm1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['west', 'West', 'West', ' West '] },
  });
  assert.deepEqual(request.sourceMetricIds, ['m1', 'm2']);
  assert.deepEqual(request.selection.values, [' West ', 'West', 'west']);
  assert.equal(fingerprintValues(['West', 'Central']), fingerprintValues(['Central', 'West', 'West']));
  assert.notEqual(fingerprintValues(['West']), fingerprintValues(['west']));
  assert.throws(() => canonicalizeDimensionalForkRequest({
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['   '] },
  }));
});

test('dimensional request rejects malformed and over-limit input', () => {
  const request = (sourceMetricIds: string[], values: string[]) => ({
    version: 1,
    sourceMetricIds,
    fieldId: 'Region',
    selection: { mode: 'VALUES', values },
  });
  assert.throws(() => canonicalizeDimensionalForkRequest(request([], ['West'])));
  assert.throws(() => canonicalizeDimensionalForkRequest(request(['m1'], [])));
  // Source count is unbounded: Tableau has no batch endpoint, so each source is
  // its own create call regardless of how many are requested.
  assert.doesNotThrow(() => canonicalizeDimensionalForkRequest(request(
    Array.from({ length: 200 }, (_, index) => `m${index}`),
    ['West'],
  )));
  // Selected-value count is unbounded: a user can never select more distinct
  // values than the domain holds, so neither 100 nor 1250 caps a selection.
  assert.doesNotThrow(() => canonicalizeDimensionalForkRequest(request(
    ['m1'],
    Array.from({ length: 101 }, (_, index) => `Value ${index}`),
  )));
  assert.doesNotThrow(() => canonicalizeDimensionalForkRequest(request(
    ['m1'],
    Array.from({ length: 1251 }, (_, index) => `Value ${index}`),
  )));
  // Per-value character length is still bounded.
  assert.throws(() => canonicalizeDimensionalForkRequest(request(['m1'], ['x'.repeat(257)])));
  assert.equal(canonicalizeDimensionalForkRequest(request(['m1'], ['😀'.repeat(200)]))
    .selection.values[0], '😀'.repeat(200));
  // exclude defaults to false and round-trips when set.
  assert.equal(canonicalizeDimensionalForkRequest(request(['m1'], ['West'])).selection.exclude, false);
  assert.equal(canonicalizeDimensionalForkRequest({
    version: 1, sourceMetricIds: ['m1'], fieldId: 'Region',
    selection: { mode: 'VALUES', exclude: true, values: ['West'] },
  }).selection.exclude, true);
});

test('eligible dimensions intersect string fields with every allowed_dimensions list', async () => {
  const service = new PulseDimensionalForkService(dependencies());
  const result = await service.listEligibleDimensions(session, ['m1', 'm2']);
  assert.deepEqual(result.fields.map((field) => field.id), ['Region']);
  assert.deepEqual(result.fields[0], {
    id: 'Region',
    name: 'Region',
    label: 'Region',
    table: 'Orders',
    role: 'dimension',
    dataType: 'string',
    providerReference: { fieldName: 'Region' },
  });
});

test('eligible dimensions reject incompatible source datasources', async () => {
  const deps = dependencies({
    getDefinition: async (_session, definitionId) => ({
      specification: { datasource: { id: definitionId === 'd1' ? 'ds-1' : 'ds-2' } },
      extension_options: { allowed_dimensions: ['Region'] },
    }),
  });
  await assert.rejects(
    () => new PulseDimensionalForkService(deps).listEligibleDimensions(session, ['m1', 'm2']),
    /same datasource/,
  );
});

test('eligible dimensions require a VDS-backed catalog', async () => {
  const deps = dependencies({
    getCatalog: async () => ({ ...catalog([dimension('Region')]), source: 'metadata' }),
  });
  await assert.rejects(
    () => new PulseDimensionalForkService(deps).listEligibleDimensions(session, ['m1']),
    /require a current VDS field catalog/,
  );
});

test('filter merge clones the source, replaces one same-field filter, and preserves exact comparison', () => {
  const source = {
    datasource: { id: '00000000-0000-0000-0000-000000000000' },
    filters: [
      { field: 'Segment', operator: 'OPERATOR_EQUAL', categorical_values: [{ string_value: 'Consumer' }] },
      { field: 'Region', operator: 'OLD', categorical_values: [{ string_value: 'East' }] },
    ],
    measurement_period: { granularity: 'GRANULARITY_MONTH' },
    comparison: { nested: ['preserve', { exactly: true }] },
  };
  const result = mergePulseStringFilter(source, 'Region', ['West', 'Central', 'West']);
  assert.notEqual(result, source);
  assert.deepEqual(source.filters[1], { field: 'Region', operator: 'OLD', categorical_values: [{ string_value: 'East' }] });
  assert.deepEqual(result, {
    filters: [
      source.filters[0],
      {
        field: 'Region',
        operator: 'OPERATOR_EQUAL',
        categorical_values: [{ string_value: 'Central' }, { string_value: 'West' }],
        include_null: false,
      },
    ],
    measurement_period: source.measurement_period,
    comparison: source.comparison,
  });
});

test('filter merge emits OPERATOR_NOT_EQUAL when excluding values', () => {
  const result = mergePulseStringFilter({ filters: [] }, 'Region', ['West', 'Central'], true);
  assert.deepEqual(result, {
    filters: [
      {
        field: 'Region',
        operator: 'OPERATOR_NOT_EQUAL',
        categorical_values: [{ string_value: 'Central' }, { string_value: 'West' }],
        include_null: false,
      },
    ],
  });
});

test('filter merge rejects multiple existing filters on the selected field', () => {
  assert.throws(() => mergePulseStringFilter({
    filters: [{ field: 'Region' }, { field: 'Region' }],
  }, 'Region', ['West']), /multiple filters/);
});

test('filter merge rejects malformed non-array source filters', () => {
  assert.throws(() => mergePulseStringFilter({ filters: { field: 'Region' } }, 'Region', ['West']), /must be an array/);
});

test('fork summarizes created, existing, and failed results independently', async () => {
  const specifications: Record<string, Record<string, unknown>> = {};
  const deps = dependencies({
    getOrCreate: async (_session, input) => {
      specifications[input.definitionId] = input.specification;
      if (input.definitionId === 'd1') return { metricId: 'fork-1', metricApiName: 'fork_one', created: true };
      return { metricId: 'fork-2', created: false };
    },
  });
  const sourceM1 = await deps.getMetric(session, 'm1');
  const summary = await new PulseDimensionalForkService(deps).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m2', 'm1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West', 'Central'] },
  });
  assert.deepEqual({ attempted: summary.attempted, created: summary.created, existing: summary.existing, failed: summary.failed }, {
    attempted: 2,
    created: 1,
    existing: 1,
    failed: 0,
  });
  assert.equal(summary.results[0]?.sourceMetricId, 'm1');
  assert.equal(summary.results[0]?.createdApiName, 'fork_one');
  assert.equal(summary.results[0]?.reconciliationStatus, 'visible');
  assert.equal(summary.results[0]?.ownershipVerified, true);
  assert.deepEqual(summary.results[0]?.requestedSpecification, specifications.d1);
  assert.deepEqual(specifications.d1?.comparison, sourceM1.specification?.comparison);
  assert.deepEqual((specifications.d1?.filters as unknown[])[1], {
    field: 'Region',
    operator: 'OPERATOR_EQUAL',
    categorical_values: [{ string_value: 'Central' }, { string_value: 'West' }],
    include_null: false,
  });
});

test('fork reports provider failures without hiding successful creates', async () => {
  const deps = dependencies({
    getOrCreate: async (_session, input) => {
      if (input.definitionId === 'd2') throw new Error('comparison rejected by pod');
      return { metricId: 'fork-1', created: true };
    },
  });
  const summary = await new PulseDimensionalForkService(deps).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1', 'm2'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  });
  assert.deepEqual({ created: summary.created, failed: summary.failed }, { created: 1, failed: 1 });
  assert.match(summary.results[1]?.error ?? '', /comparison rejected/);
  assert.equal(dimensionalForkHttpStatus(summary), 207);
});

test('fork rejects returned metrics that fail reconciliation', async () => {
  const summary = await new PulseDimensionalForkService(dependencies({
    reconcile: async (_session, input) => ({
      metricId: input.metricId,
      status: input.definitionId === 'd1' ? 'ownership_mismatch' : 'failed',
      exactMetricResolved: true,
      inventoryVisible: false,
      ownershipVerified: false,
      attempts: 1,
      diagnostic: { message: `Reconciliation rejected ${input.metricId}.` },
    }),
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1', 'm2'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  });

  assert.equal(summary.created, 2);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.results.map((result) => result.status), ['failed', 'failed']);
  assert.deepEqual(
    summary.results.map((result) => result.reconciliationStatus),
    ['ownership_mismatch', 'failed'],
  );
  assert.match(summary.results[0]?.error ?? '', /Reconciliation rejected/);
  assert.equal(dimensionalForkHttpStatus(summary), 207);
});

test('fork validates selected values with a targeted query and rejects values no longer present', async () => {
  let queryCalls = 0;
  let createCalls = 0;
  const deps = dependencies({
    // First call fills the fetch-all listing; the fork's targeted validation
    // query then finds that 'West' is gone from the provider domain.
    queryValues: async () => {
      queryCalls += 1;
      return queryCalls === 1 ? [['West'], ['Central']] : [['Central']];
    },
    getOrCreate: async () => {
      createCalls += 1;
      return { metricId: 'fork-1', created: true };
    },
  });
  const service = new PulseDimensionalForkService(deps);
  await service.listDimensionValues(session, { sourceMetricIds: ['m1'], fieldId: 'Region' });
  await assert.rejects(() => service.forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  }), /not present in the current provider domain/);
  assert.equal(queryCalls, 2);
  assert.equal(createCalls, 0);
});

test('fork validates selected values against a large domain via a targeted set filter', async () => {
  let setFilterValues: string[] | undefined;
  let createCalls = 0;
  const deps = dependencies({
    queryCount: async () => 5_000,
    // A member well beyond the fetch-all cap; the targeted set-filter query
    // confirms it exists so the fork proceeds.
    queryValues: async (_session, input) => {
      if (input.matchValues) {
        setFilterValues = input.matchValues;
        return input.matchValues.map((value) => [value]);
      }
      return Array.from({ length: input.rowLimit }, (_, index) => [`Value ${index}`]);
    },
    getOrCreate: async () => {
      createCalls += 1;
      return { metricId: 'fork-1', created: true };
    },
  });
  const summary = await new PulseDimensionalForkService(deps).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['Deep Member'] },
  });
  assert.equal(summary.created, 1);
  assert.equal(createCalls, 1);
  assert.deepEqual(setFilterValues, ['Deep Member']);
});

test('fork returns settled Tableau auth failures from create and reconciliation', async (t) => {
  for (const phase of ['create', 'reconciliation'] as const) {
    await t.test(phase, async () => {
      const authError = new TableauError('Tableau session expired.', 401, '', 'auth');
      const service = new PulseDimensionalForkService(dependencies({
        ...(phase === 'create'
          ? { getOrCreate: async () => { throw authError; } }
          : { reconcile: async () => { throw authError; } }),
      }));

      const summary = await service.forkMetrics(session, {
        version: 1, sourceMetricIds: ['m1'], fieldId: 'Region', selection: { mode: 'VALUES', values: ['West'] },
      });
      assert.equal(summary.terminated, true);
      assert.equal(summary.results[0]?.creationStatus, phase === 'create' ? 'unknown' : 'created');
      assert.match(summary.results[0]?.error ?? '', /expired/);
      if (phase === 'reconciliation') assert.ok(summary.results[0]?.createdMetricId);

    });
  }
});

test('fork accepts exact selected values present in a provider-cap-sized domain', async () => {
  let createCalls = 0;
  const deps = dependencies({
    queryValues: async () => Array.from({ length: 1_000 }, (_, index) => [`Value ${index}`]),
    getOrCreate: async () => {
      createCalls += 1;
      return { metricId: 'fork-1', created: true };
    },
  });
  const summary = await new PulseDimensionalForkService(deps).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['Value 1'] },
  });
  assert.equal(summary.created, 1);
  assert.equal(createCalls, 1);
});

test('count query returns the distinct-member total for an eligible field', async () => {
  const service = new PulseDimensionalForkService(dependencies({ queryCount: async () => 4_200 }));
  const result = await service.countDimensionMembers(session, { sourceMetricIds: ['m1'], fieldId: 'Region' });
  assert.deepEqual(result, { fieldId: 'Region', count: 4_200 });
  await assert.rejects(
    () => service.countDimensionMembers(session, { sourceMetricIds: ['m1'], fieldId: 'Missing' }),
    /not eligible/,
  );
});

test('fetch-all values return the full sorted, deduped, blank-free domain without a cursor', async () => {
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async () => [['West'], ['Central'], ['West'], [null], ['   '], ['East']],
  }));
  const page = await service.listDimensionValues(session, { sourceMetricIds: ['m1'], fieldId: 'Region' });
  assert.deepEqual(page.values.map((value) => value.value), ['Central', 'East', 'West']);
  assert.equal(page.truncated, false);
  assert.equal('nextCursor' in page, false);
});

test('fetch-all values report truncation when the provider fills the bounded limit', async () => {
  let rowLimit = 0;
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async (_session, input) => {
      rowLimit = input.rowLimit;
      return Array.from({ length: input.rowLimit }, (_, index) => [`Value ${index}`]);
    },
  }));
  const page = await service.listDimensionValues(session, { sourceMetricIds: ['m1'], fieldId: 'Region' });
  assert.equal(rowLimit, DIMENSIONAL_FORK_LIMITS.valueModeThreshold + 1);
  assert.equal(page.truncated, true);
});

test('search issues a server-side contains query bounded only by the fetch ceiling', async () => {
  let captured: { contains?: string; rowLimit?: number } = {};
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async (_session, input) => {
      captured = { contains: input.contains, rowLimit: input.rowLimit };
      return [['Match 0'], ['Match 1'], ['Match 2']];
    },
  }));
  const page = await service.listDimensionValues(session, {
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    search: '  match  ',
  });
  assert.equal(captured.contains, 'match');
  assert.equal(captured.rowLimit, DIMENSION_VALUE_FETCH_CEILING);
  assert.equal(page.values.length, 3);
  assert.equal(page.truncated, false);
});

test('load all fetches the whole domain in one query bounded only by the fetch ceiling', async () => {
  let captured: { contains?: string; rowLimit?: number } = {};
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async (_session, input) => {
      captured = { contains: input.contains, rowLimit: input.rowLimit };
      return [['Central'], ['East'], ['West']];
    },
  }));
  const page = await service.listDimensionValues(session, {
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    all: true,
  });
  assert.equal(captured.contains, undefined);
  assert.equal(captured.rowLimit, DIMENSION_VALUE_FETCH_CEILING);
  assert.deepEqual(page.values.map((value) => value.value), ['Central', 'East', 'West']);
  assert.equal(page.truncated, false);
});

test('search returns an untruncated match set when the provider is under the cap', async () => {
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async () => [['Western Europe'], ['West']],
  }));
  const page = await service.listDimensionValues(session, {
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    search: 'west',
  });
  assert.deepEqual(page.values.map((value) => value.value), ['West', 'Western Europe']);
  assert.equal(page.truncated, false);
});

test('values mark unsupported provider values as truncated', async () => {
  const service = new PulseDimensionalForkService(dependencies({
    queryValues: async () => [['x'.repeat(257)]],
  }));
  const page = await service.listDimensionValues(session, { sourceMetricIds: ['m1'], fieldId: 'Region' });
  assert.equal(page.truncated, true);
  assert.deepEqual(page.values, []);
});

test('fork HTTP status distinguishes success, mixed results, total provider failure, and total source failure', async () => {
  const successful = await new PulseDimensionalForkService(dependencies()).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  });
  assert.equal(dimensionalForkHttpStatus(successful), 200);

  const providerFailure = await new PulseDimensionalForkService(dependencies({
    getOrCreate: async () => { throw new Error('provider unavailable'); },
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  });
  assert.equal(dimensionalForkHttpStatus(providerFailure), 502);

  const sourceFailure = await new PulseDimensionalForkService(dependencies({
    getMetric: async () => ({
      id: 'm1',
      definition_id: 'd1',
      specification: { filters: { field: 'Region' } },
    }),
  })).forkMetrics(session, {
    version: 1,
    sourceMetricIds: ['m1'],
    fieldId: 'Region',
    selection: { mode: 'VALUES', values: ['West'] },
  });
  assert.equal(dimensionalForkHttpStatus(sourceFailure), 422);
});

test('route query parser retains repeated source metric identifiers', () => {
  assert.deepEqual(repeatedQueryValues(['m1', 'm2']), ['m1', 'm2']);
  assert.deepEqual(repeatedQueryValues('m1'), ['m1']);
  assert.deepEqual(repeatedQueryValues(undefined), []);
});
