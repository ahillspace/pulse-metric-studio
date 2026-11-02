import type { CatalogField,DatasourceCatalog,MetricSelection } from '@pulse-metric-studio/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCreatePayloads } from './serializer.js';

function field(overrides: Partial<CatalogField> & Pick<CatalogField, 'id' | 'role'>): CatalogField {
  return {
    label: overrides.label ?? overrides.caption ?? overrides.name ?? overrides.id,
    name: overrides.name ?? overrides.id,
    caption: overrides.caption ?? overrides.label ?? overrides.name ?? overrides.id,
    dataType: 'REAL',
    table: 'Orders',
    defaultAggregation: null,
    formula: null,
    requiresUserAgg: false,
    ...overrides,
  } as CatalogField;
}

function catalog(over: Partial<DatasourceCatalog>): DatasourceCatalog {
  return {
    datasourceLuid: 'ds-luid',
    datasourceName: 'Orders',
    measures: [],
    dimensions: [],
    timeDimensions: [],
    parameters: [],
    excluded: [],
    source: 'vds',
    warnings: [],
    ...over,
  } as DatasourceCatalog;
}

function metric(over: Partial<MetricSelection> & Pick<MetricSelection, 'fieldId' | 'timeDimensionFieldId'>): MetricSelection {
  return {
    active: true,
    fieldLabel: over.fieldId,
    requiresUserAgg: false,
    aggregation: 'AVG',
    cumulative: false,
    format: 'NUMBER',
    sentiment: 'NONE',
    name: over.name ?? 'Metric',
    description: '',
    minGranularity: 'DAY',
    temporality: 'OVER_TIME',
    locks: [],
    ...over,
  } as MetricSelection;
}

function spec(payload: Record<string, unknown>): { measure: { field: string }; time_dimension: { field: string } } {
  const specification = payload.specification as { basic_specification: { measure: { field: string }; time_dimension: { field: string } } };
  return specification.basic_specification;
}

function allowedDimensions(payload: Record<string, unknown>): string[] {
  return (payload.extension_options as { allowed_dimensions: string[] }).allowed_dimensions;
}

// Calc fields emit their raw internal Calculation id; MQS resolves calc
// references by id/name, not caption.
test('calc-backed measure emits its raw internal Calculation id, not the caption', () => {
  const measure = field({
    id: 'Calculation_123456789',
    name: 'Calculation_123456789',
    caption: 'Average Deal Cycle',
    label: 'Average Deal Cycle',
    role: 'MEASURE',
    formula: "AVG(DATEDIFF('day',[Order Date],[Ship Date]))",
  });
  const timeDim = field({ id: 'Order Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'Calculation_123456789', timeDimensionFieldId: 'Order Date' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).measure.field, 'Calculation_123456789');
});

test('calc-backed time dimension emits its raw internal Calculation id, not the caption', () => {
  const measure = field({ id: 'sales', name: 'sales', caption: 'Sales', role: 'MEASURE' });
  const timeDim = field({
    id: 'Calculation_987654321',
    name: 'Calculation_987654321',
    caption: 'Fiscal Close Date',
    label: 'Fiscal Close Date',
    role: 'DIMENSION',
    dataType: 'DATE',
    timeType: 'DATE',
    formula: "DATE([Close])",
  });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'sales', timeDimensionFieldId: 'Calculation_987654321' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).time_dimension.field, 'Calculation_987654321');
});

test('calc-backed dimension slicer emits its raw internal Calculation id in allowed_dimensions, not the caption', () => {
  const measure = field({ id: 'sales', name: 'sales', caption: 'Sales', role: 'MEASURE' });
  const timeDim = field({ id: 'order_date', name: 'order_date', caption: 'Order Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' });
  const calcSlicer = field({
    id: 'Calculation_555',
    name: 'Calculation_555',
    caption: 'Deal Size Bucket',
    label: 'Deal Size Bucket',
    role: 'DIMENSION',
    dataType: 'STRING',
    formula: "IF [Sales] > 1000 THEN 'Large' ELSE 'Small' END",
  });
  const physicalSlicer = field({ id: 'region', name: 'region', caption: 'Region', role: 'DIMENSION', dataType: 'STRING' });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim], dimensions: [calcSlicer, physicalSlicer] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'sales', timeDimensionFieldId: 'order_date' }) },
    slicers: {
      s1: { active: true, fieldId: 'Calculation_555', fieldLabel: 'Deal Size Bucket' },
      s2: { active: true, fieldId: 'region', fieldLabel: 'Region' },
    },
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  const dims = allowedDimensions(payloads[0]);
  assert.ok(dims.includes('Calculation_555'), `expected raw calc id, got ${JSON.stringify(dims)}`);
  assert.ok(dims.includes('region'), `expected raw physical name, got ${JSON.stringify(dims)}`);
  assert.ok(!dims.includes('Deal Size Bucket'), `no caption string should leak, got ${JSON.stringify(dims)}`);
});

test('physical measure whose real name ends in a non-table parenthetical keeps it verbatim', () => {
  // Regression for validation 404904: "Deal Cycle Length (Days)" is the field's
  // actual name - "(Days)" is not a logical-table caption, so it must not be
  // stripped as a duplicate-name uniquifier.
  const measure = field({
    id: 'Deal Cycle Length (Days)',
    name: 'Deal Cycle Length (Days)',
    caption: 'Deal Cycle Length (Days)',
    role: 'MEASURE',
    dataType: 'INTEGER',
    table: 'Superstore Sales Cloud',
  });
  const timeDim = field({ id: 'Calculation_727331406536650758', name: 'Calculation_727331406536650758', caption: 'Closed Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE', table: 'Superstore Sales Cloud' });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'Deal Cycle Length (Days)', timeDimensionFieldId: 'Calculation_727331406536650758' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).measure.field, 'Deal Cycle Length (Days)');
  assert.equal(spec(payloads[0]).time_dimension.field, 'Calculation_727331406536650758');
});

test('a real duplicate-name uniquifier matching a logical-table caption is stripped', () => {
  // Two "Sales" columns across logical tables; VDS/dedup qualifies one as
  // "Sales (genres.csv)". Because "genres.csv" IS a table caption in the
  // catalog, the qualifier is stripped back to the bare column name pods know.
  const measure = field({ id: 'Sales (genres.csv)', name: 'Sales (genres.csv)', caption: 'Sales', role: 'MEASURE', table: 'genres.csv' });
  const otherTableField = field({ id: 'Title', name: 'Title', caption: 'Title', role: 'DIMENSION', dataType: 'STRING', table: 'genres.csv' });
  const timeDim = field({ id: 'order_date', name: 'order_date', caption: 'Order Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE', table: 'Orders' });
  const cat = catalog({ measures: [measure], dimensions: [otherTableField], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'Sales (genres.csv)', timeDimensionFieldId: 'order_date' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).measure.field, 'Sales');
});

test('a parenthetical that only looks like a uniquifier but is not a table caption is preserved', () => {
  const measure = field({ id: 'Quota Remaining ($)', name: 'Quota Remaining ($)', caption: 'Quota Remaining ($)', role: 'MEASURE', table: 'Orders' });
  const timeDim = field({ id: 'order_date', name: 'order_date', caption: 'Order Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE', table: 'Orders' });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'Quota Remaining ($)', timeDimensionFieldId: 'order_date' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).measure.field, 'Quota Remaining ($)');
});

test('physical-column measure and time dimension keep their raw names', () => {
  const measure = field({ id: 'quantity', name: 'quantity', caption: 'Quantity', role: 'MEASURE' });
  const timeDim = field({ id: 'order_date', name: 'order_date', caption: 'Order Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' });
  const cat = catalog({ measures: [measure], timeDimensions: [timeDim] });
  const payloads = buildCreatePayloads({
    metrics: { m1: metric({ fieldId: 'quantity', timeDimensionFieldId: 'order_date' }) },
    slicers: {},
    catalog: cat,
  });
  assert.equal(payloads.length, 1);
  assert.equal(spec(payloads[0]).measure.field, 'quantity');
  assert.equal(spec(payloads[0]).time_dimension.field, 'order_date');
});

test('current catalog overrides stale aggregation flags in both directions at the payload boundary', () => {
  const time = field({ id: 'date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' });
  for (const requiresUserAgg of [true, false]) {
    const current = catalog({ measures: [field({ id: 'Sales', role: 'MEASURE', requiresUserAgg })], timeDimensions: [time] });
    const payload = buildCreatePayloads({ catalog: current, slicers: {}, metrics: { Sales: metric({ fieldId: 'Sales', timeDimensionFieldId: 'date', requiresUserAgg: !requiresUserAgg, aggregation: requiresUserAgg ? 'SUM' : 'USER', cumulative: true }) } })[0];
    const specification = payload.specification as { basic_specification: { measure: { aggregation: string } }; is_running_total: boolean };
    assert.equal(specification.basic_specification.measure.aggregation, requiresUserAgg ? 'AGGREGATION_USER' : 'AGGREGATION_SUM');
    assert.equal(specification.is_running_total, !requiresUserAgg);
  }
});

for (const role of ['measure', 'time', 'slicer'] as const) {
  test(`rejects ambiguous ${role} references, including a real table-like parenthetical`, () => {
    const measures = [field({ id: 'Sales', role: 'MEASURE' })];
    const times = [field({ id: 'Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' })];
    const dimensions = [field({ id: 'Region', role: 'DIMENSION' })];
    const duplicate = role === 'measure' ? field({ id: 'Sales (Orders)', name: 'Sales (Orders)', caption: 'Sales (Orders)', role: 'MEASURE' })
      : role === 'time' ? field({ id: 'Date (Orders)', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' })
      : field({ id: 'Region (Orders)', role: 'DIMENSION' });
    if (role === 'measure') measures.push(duplicate);
    else if (role === 'time') times.push(duplicate);
    else dimensions.push(duplicate);
    const current = catalog({ measures, timeDimensions: times, dimensions });
    const input = { catalog: current, metrics: { Sales: metric({ fieldId: role === 'measure' ? duplicate.id : 'Sales', timeDimensionFieldId: 'Date' }) }, slicers: { Region: { fieldId: 'Region', fieldLabel: 'Region', active: true } } };
    assert.throws(() => buildCreatePayloads(input), /ambiguous Pulse field reference/);
  });
}

test('direct payload building rejects stale metric and slicer references', () => {
  const current = catalog({ measures: [field({ id: 'Sales', role: 'MEASURE' })], timeDimensions: [field({ id: 'Date', role: 'DIMENSION', dataType: 'DATE', timeType: 'DATE' })] });
  assert.throws(() => buildCreatePayloads({ catalog: current, metrics: { gone: metric({ fieldId: 'gone', timeDimensionFieldId: 'Date' }) }, slicers: {} }), /unavailable or excluded/);
  assert.throws(() => buildCreatePayloads({ catalog: current, metrics: { Sales: metric({ fieldId: 'Sales', timeDimensionFieldId: 'Date' }) }, slicers: { gone: { fieldId: 'gone', fieldLabel: 'Gone slicer', active: true } } }), /unavailable or excluded slicer/);
});
