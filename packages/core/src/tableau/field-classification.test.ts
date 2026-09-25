import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTimeDimensionId } from '@pulse-metric-studio/shared';
import { classifyNormalizedTimeType, normalizeProviderType } from './field-classification.js';
import { fieldCatalogCacheTtlMs, normalizeVdsToCatalog } from './vds-fields.js';

test('normalizes only proven provider date and timestamp spellings', () => {
  assert.equal(normalizeProviderType(' date-time '), 'DATE_TIME');
  assert.equal(classifyNormalizedTimeType('date'), 'DATE');
  assert.equal(classifyNormalizedTimeType('Date Time'), 'DATETIME');
  assert.equal(classifyNormalizedTimeType('TIMESTAMP'), 'DATETIME');
  assert.equal(classifyNormalizedTimeType('DATE_STRING'), null);
  assert.equal(classifyNormalizedTimeType('TIME'), null);
  assert.equal(classifyNormalizedTimeType('updated_timestamp_text'), null);
});

test('keeps visible Calculation fields with explicit Tableau date types eligible', () => {
  const catalog = normalizeVdsToCatalog(
    {
      fieldProvenance: 'vds_read_metadata',
      datasourceModel: { logicalTables: [{ logicalTableId: 'Orders_A1B2C3D4', caption: 'Orders' }] },
      fieldGroups: [{
        logicalTableId: 'Orders_A1B2C3D4',
        fields: [
          {
            name: 'Calculation_Closed_Date',
            caption: 'Closed Date',
            dataType: 'DATE',
            fieldType: 'CONTINUOUS',
            columnClass: 'CALC',
            formula: 'DATE([Closed At])',
            role: 'DIMENSION',
            logicalTableId: 'Orders_A1B2C3D4',
          },
          {
            name: 'Calculation_Ship_Date',
            caption: 'Ship Date',
            dataType: 'DATETIME',
            fieldType: 'ORDINAL',
            columnClass: 'CALC',
            formula: '[Ship Timestamp]',
            role: 'DIMENSION',
            logicalTableId: 'Orders_A1B2C3D4',
          },
          {
            name: 'Status Date Text',
            caption: 'Status Date Text',
            dataType: 'DATE_STRING',
            fieldType: 'NOMINAL',
            role: 'DIMENSION',
            logicalTableId: 'Orders_A1B2C3D4',
          },
          {
            name: 'Calculation_Internal_Date',
            caption: 'Internal Date',
            dataType: 'DATE',
            fieldType: 'CONTINUOUS',
            columnClass: 'CALC',
            formula: 'DATE([Internal Timestamp])',
            isHidden: true,
            role: 'DIMENSION',
            logicalTableId: 'Orders_A1B2C3D4',
          },
          { name: 'Sales', caption: 'Sales', dataType: 'REAL', role: 'MEASURE', logicalTableId: 'Orders_A1B2C3D4' },
        ],
      }],
    },
    { luid: 'source-1', name: 'Orders' },
    'vds',
  );

  assert.deepEqual(catalog.timeDimensions.map((field) => [field.id, field.timeType]), [
    ['Calculation_Closed_Date', 'DATE'],
    ['Calculation_Ship_Date', 'DATETIME'],
  ]);
  const closedDate = catalog.timeDimensions.find((field) => field.id === 'Calculation_Closed_Date');
  const shipDate = catalog.timeDimensions.find((field) => field.id === 'Calculation_Ship_Date');
  assert.equal(catalog.dimensions[0]?.id, 'Status Date Text');
  assert.equal(closedDate?.label, 'Closed Date');
  assert.equal(closedDate?.providerType, 'DATE');
  assert.equal(closedDate?.physicalType, null);
  assert.equal(closedDate?.logicalTableId, 'Orders_A1B2C3D4');
  assert.equal(closedDate?.provenance, 'vds_read_metadata');
  assert.equal(shipDate?.label, 'Ship Date');
  assert.equal(shipDate?.providerType, 'DATETIME');
  assert.deepEqual(catalog.excluded.map(({ field, reason }) => [field.id, reason]), [
    ['Calculation_Internal_Date', 'internal'],
  ]);
  assert.deepEqual(catalog.diagnostics, {
    counts: { discovered: 5, measures: 1, dimensions: 1, timeDimensions: 2, excluded: 1 },
    excludedByReason: { internal: 1 },
    timeDimensionExcludedByReason: { excluded: 1, measureRole: 1, unsupportedType: 1 },
    suspiciousZeroTimeDimensions: false,
  });
  assert.deepEqual(validateTimeDimensionId(catalog, 'Calculation_Closed_Date'), { eligible: true, field: closedDate });
  assert.deepEqual(validateTimeDimensionId(catalog, 'Status Date Text'), { eligible: false, reason: 'not_time_dimension' });
});

test('uses a short cache lifetime for zero-time catalogs', () => {
  assert.equal(fieldCatalogCacheTtlMs({ timeDimensions: [] }), 15_000);
  assert.equal(fieldCatalogCacheTtlMs({
    timeDimensions: [{
      id: 'Order Date',
      name: 'Order Date',
      label: 'Order Date',
      caption: 'Order Date',
      role: 'DIMENSION',
      dataType: 'DATE',
      table: null,
      defaultAggregation: null,
      formula: null,
      requiresUserAgg: false,
    }],
  }), 5 * 60_000);
});

test('preserves metadata fallback provenance and normalizes its date types', () => {
  const catalog = normalizeVdsToCatalog(
    {
      fieldGroups: [{
        fields: [{ name: 'Shipped At', dataType: 'date-time', role: 'DIMENSION' }],
      }],
    },
    { luid: 'source-2', name: 'Shipments' },
    'metadata',
  );

  assert.equal(catalog.timeDimensions[0]?.timeType, 'DATETIME');
  assert.equal(catalog.timeDimensions[0]?.providerType, 'date-time');
  assert.equal(catalog.timeDimensions[0]?.physicalType, null);
  assert.equal(catalog.timeDimensions[0]?.provenance, 'metadata_graphql');
});
