import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  emptyPulseDocument,
  PulseWorkspaceDocumentV1Schema,
  PULSE_TEXT_LIMITS,
} from './pulse-contracts.js';
import {
  applyPulseProposal,
  defaultPulseMetric,
  reconcilePulseMetric,
  mergePulseProposal,
} from './pulse-domain.js';
import type { DatasourceCatalog } from './field-catalog.js';
import { describePulseDocumentChanges } from './pulse-proposal.js';

const catalog: DatasourceCatalog = {
  datasourceLuid: 'ds',
  datasourceName: 'Sales',
  source: 'vds',
  parameters: [],
  warnings: [],
  excluded: [],
  dimensions: [],
  measures: [
    {
      id: 'Sales',
      name: 'Sales',
      label: 'Sales',
      caption: 'Sales',
      role: 'MEASURE',
      dataType: 'REAL',
      table: null,
      defaultAggregation: null,
      formula: null,
      requiresUserAgg: true,
    },
  ],
  timeDimensions: [
    {
      id: 'Date',
      name: 'Date',
      label: 'Date',
      caption: 'Date',
      role: 'DIMENSION',
      dataType: 'DATE',
      table: null,
      defaultAggregation: null,
      formula: null,
      requiresUserAgg: false,
    },
  ],
};
test('workspace accepts long business labels and descriptions within documented app resource guards', () => {
  const document = emptyPulseDocument();
  document.metrics.Sales = {
    ...defaultPulseMetric(catalog, 'Sales')!,
    name: 'N'.repeat(8192),
    description: 'D'.repeat(65536),
  };
  document.digestAudience = 'A'.repeat(8192);
  const parsed = PulseWorkspaceDocumentV1Schema.parse(document);
  assert.equal(parsed.metrics.Sales!.name.length, 8192);
  assert.equal(parsed.metrics.Sales!.description.length, 65536);
  assert.equal(parsed.digestAudience.length, 8192);
  document.metrics.Sales!.name = 'N'.repeat(PULSE_TEXT_LIMITS.name + 1);
  assert.equal(PulseWorkspaceDocumentV1Schema.safeParse(document).success, false);
});

test('proposal preserves locks and never trusts persisted aggregate eligibility', () => {
  const document = emptyPulseDocument();
  document.metrics.Sales = {
    ...defaultPulseMetric(catalog, 'Sales')!,
    name: 'Locked revenue',
    locks: ['name'],
    cumulative: true,
    aggregation: 'SUM',
  };
  const parsed = PulseWorkspaceDocumentV1Schema.parse({
    ...document,
    metrics: { Sales: { ...document.metrics.Sales, requiresUserAgg: false } },
  });
  assert.equal('requiresUserAgg' in parsed.metrics.Sales!, false);
  const result = applyPulseProposal(
    parsed,
    [
      {
        op: 'MODIFY_METRIC',
        fieldId: 'Sales',
        name: 'Ignored',
        description: 'Accepted',
      },
    ],
    catalog,
  );
  assert.equal(result.metrics.Sales?.name, 'Locked revenue');
  assert.equal(result.metrics.Sales?.description, 'Accepted');
  assert.equal(result.metrics.Sales?.aggregation, 'USER');
  assert.equal(result.metrics.Sales?.cumulative, false);
  assert.equal(parsed.metrics.Sales?.description, '');
  assert.equal(
    reconcilePulseMetric(catalog, parsed.metrics.Sales!).requiresUserAgg,
    true,
  );
});

test('three-way proposal merges compatible edits while retaining manual locks and removals', () => {
  const base = emptyPulseDocument();
  base.metrics.Sales = defaultPulseMetric(catalog, 'Sales')!;
  const candidate = structuredClone(base);
  candidate.metrics.Sales!.name = 'Assistant name';
  candidate.metrics.Sales!.description = 'Useful description';
  const current = structuredClone(base);
  current.metrics.Sales!.name = 'Manual name';
  current.metrics.Sales!.locks = ['name'];
  const merged = mergePulseProposal(base, candidate, current);
  assert.equal(merged.document.metrics.Sales!.name, 'Manual name');
  assert.equal(merged.document.metrics.Sales!.description, 'Useful description');
  assert.deepEqual(merged.skipped, ['metrics.Sales.name']);
  delete current.metrics.Sales;
  assert.deepEqual(mergePulseProposal(base, candidate, current).document.metrics, {});
  candidate.metrics.New = { ...base.metrics.Sales!, fieldId: 'New' };
  assert.deepEqual(mergePulseProposal(base, candidate, current, true).document.metrics, {});
});


test('new authoring metrics have an explicit daily minimum and over-time data mode', () => {
  const metric = defaultPulseMetric(catalog, 'Sales')!;
  assert.equal(metric.minGranularity, 'DAY');
  assert.equal(metric.temporality, 'OVER_TIME');
});

test('assistant cannot select data mode even when a provider emits an unsupported property', () => {
  const result = applyPulseProposal(emptyPulseDocument(), [
    { op: 'ADD_METRIC', fieldId: 'Sales', temporality: 'LATEST' } as any,
  ], catalog);
  assert.equal(result.metrics.Sales!.temporality, 'OVER_TIME');
  assert.equal(result.metrics.Sales!.minGranularity, 'DAY');
  result.metrics.Sales!.temporality = 'LATEST';
  result.metrics.Sales!.minGranularity = 'MONTH';
  const edited = applyPulseProposal(result, [
    { op: 'MODIFY_METRIC', fieldId: 'Sales', description: 'Renamed', temporality: 'OVER_TIME' } as any,
  ], catalog);
  assert.equal(edited.metrics.Sales!.temporality, 'LATEST');
  assert.equal(edited.metrics.Sales!.minGranularity, 'MONTH');
});

test('explicit minimum granularity remains editable through assistant operations', () => {
  const result = applyPulseProposal(emptyPulseDocument(), [
    { op: 'ADD_METRIC', fieldId: 'Sales', minGranularity: 'MONTH' },
  ], catalog);
  assert.equal(result.metrics.Sales!.minGranularity, 'MONTH');
});

test('proposal edits and merges treat inherited object names as datasource field IDs', () => {
  for (const fieldId of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const fields = { ...catalog, measures: [{ ...catalog.measures[0]!, id: fieldId, name: fieldId }] };
    const base = emptyPulseDocument();
    const candidate = applyPulseProposal(base, [
      { op: 'ADD_METRIC', fieldId, description: 'Added by assistant' },
    ], fields);
    assert.equal(Object.hasOwn(candidate.metrics, fieldId), true);
    assert.equal(candidate.metrics[fieldId]!.description, 'Added by assistant');
    assert.match(describePulseDocumentChanges(base, candidate, fields).find((change) => change.field === `${fieldId}.name`)!.message, /from \(none\) to Sales/);
    const merged = mergePulseProposal(base, candidate, base).document;
    assert.deepEqual(merged.metrics[fieldId], candidate.metrics[fieldId]);
    const modified = applyPulseProposal(merged, [
      { op: 'MODIFY_METRIC', fieldId, name: 'Updated metric' },
    ], fields);
    assert.equal(modified.metrics[fieldId]!.name, 'Updated metric');
    const removed = applyPulseProposal(modified, [{ op: 'REMOVE_METRIC', fieldId }], fields);
    assert.equal(removed.metrics[fieldId]!.active, false);
    assert.deepEqual(applyPulseProposal(base, [{ op: 'REMOVE_METRIC', fieldId }], fields), base);
    const dimensionCatalog = { ...fields, dimensions: [{ ...fields.measures[0]!, role: 'DIMENSION' as const }] };
    const withSlicer = applyPulseProposal(base, [{ op: 'ADD_SLICER', fieldId }], dimensionCatalog);
    assert.equal(Object.hasOwn(withSlicer.slicers, fieldId), true);
    assert.equal(withSlicer.slicers[fieldId]!.active, true);
    const withoutSlicer = applyPulseProposal(withSlicer, [{ op: 'REMOVE_SLICER', fieldId }], dimensionCatalog);
    assert.equal(withoutSlicer.slicers[fieldId]!.active, false);
    assert.equal(describePulseDocumentChanges(withSlicer, withoutSlicer)[0]!.message, 'Sales: slicer removed.');
    assert.deepEqual(applyPulseProposal(base, [{ op: 'REMOVE_SLICER', fieldId }], dimensionCatalog), base);
    const roundTrip = PulseWorkspaceDocumentV1Schema.parse(JSON.parse(JSON.stringify(candidate)));
    assert.deepEqual(roundTrip, candidate);
    assert.equal(Object.getPrototypeOf(roundTrip.metrics), Object.prototype);
  }
  for (const metrics of [[], null, new Map(), new Date(), 'invalid'])
    assert.equal(PulseWorkspaceDocumentV1Schema.safeParse({ ...emptyPulseDocument(), metrics }).success, false);
});
