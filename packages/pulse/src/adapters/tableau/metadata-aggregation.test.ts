import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGraphqlNodes, normalizeVdsToCatalog } from '@pulse-metric-studio/core';
import { defaultPulseMetric, reconcileMetricWithCatalog } from '@pulse-metric-studio/shared';
import { buildCreatePayloads } from './serializer.js';

for (const [formula, aggregated] of [
  ['MIN([Sales], 0)', false],
  ['MAX([Sales], 0)', false],
  ['MIN(IFNULL([Sales], 0), MAX([Profit], 10))', false],
  ['MIN([Sales])', true],
  ['MAX([Sales])', true],
  ['MIN(SUM([Sales]), SUM([Profit]))', true],
  ['PERCENTILE([Sales], 0.90)', true],
  ['CORR([Sales], [Profit])', true],
  ['COVAR([Sales], [Profit])', true],
  ['COVARP([Sales], [Profit])', true],
  ['RAWSQLAGG_REAL("SUM(%1)", [Sales])', true],
  ['RAWSQL_REAL("%1 * 2", [Sales])', false],
  ['MIN({ FIXED [Region] : SUM([Sales]) }, 0)', false],
  ['/* MAX([Sales]) */ [Sales] * 2', false],
] as const) {
  test(`metadata fallback preserves aggregation through dependent publishing: ${formula}`, () => {
    const rows = classifyGraphqlNodes([
      { __typename: 'ColumnField', name: 'Sales', fullyQualifiedName: '[Sales]', role: 'MEASURE', dataType: 'REAL' },
      { __typename: 'ColumnField', name: 'Profit', fullyQualifiedName: '[Profit]', role: 'MEASURE', dataType: 'REAL' },
      { __typename: 'ColumnField', name: 'Order Date', fullyQualifiedName: '[Order Date]', role: 'DIMENSION', dataType: 'DATE' },
      { __typename: 'CalculatedField', name: 'Base calculation', fullyQualifiedName: '[Calculation_1]',
        role: 'MEASURE', dataType: 'REAL', aggregation: 'SUM', formula },
      { __typename: 'CalculatedField', name: 'Dependent calculation', fullyQualifiedName: '[Calculation_2]',
        role: 'MEASURE', dataType: 'REAL', aggregation: 'SUM', formula: '[Base calculation] * 2' },
      { __typename: 'CalculatedField', name: 'LOD calculation', fullyQualifiedName: '[Calculation_3]',
        role: 'MEASURE', dataType: 'REAL', aggregation: 'SUM', formula: '{ FIXED : [Base calculation] }' },
    ]);
    const catalog = normalizeVdsToCatalog({ fieldGroups: [{ fields: rows }] }, { luid: 'fixture-datasource', name: 'Fixture' }, 'metadata');
    for (const id of ['Calculation_1', 'Calculation_2', 'Calculation_3']) {
      const expected = id !== 'Calculation_3' && aggregated;
      assert.equal(catalog.measures.find((field) => field.id === id)?.requiresUserAgg, expected, id);
      const metric = reconcileMetricWithCatalog(catalog, {
        ...defaultPulseMetric(catalog, id)!, requiresUserAgg: false,
        aggregation: 'AVERAGE', timeDimensionFieldId: 'Order Date', active: true,
      });
      const payload = buildCreatePayloads({ catalog, metrics: { [id]: metric }, slicers: {} })[0];
      const specification = payload.specification as { basic_specification: { measure: { aggregation: string } } };
      assert.equal(specification.basic_specification.measure.aggregation,
        expected ? 'AGGREGATION_USER' : 'AGGREGATION_AVERAGE', id);
    }
  });
}
