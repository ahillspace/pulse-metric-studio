import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import type { TableauSession } from './rest-client.js';
import {
  canonicalPulseIdentifier,
  classifyGraphqlNodes,
  detectBlendedRef,
  fetchFieldsViaMetadataGraphql,
  isTableCalcFormula,
  requiresUserAggFromFormula,
} from './metadata-fallback.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function session(): TableauSession {
  return {
    serverUrl: 'https://mf.example.test',
    siteContentUrl: '',
    siteId: 'site-1',
    userId: 'user-1',
    token: 'token-mf',
    apiVersion: '3.27',
  };
}

const byName = (rows: ReturnType<typeof classifyGraphqlNodes>, name: string) =>
  rows.find((r) => r.caption === name);

test('table-calc detection covers the full function list', () => {
  assert.equal(isTableCalcFormula('WINDOW_SUM([Sales])'), true);
  assert.equal(isTableCalcFormula('INDEX()'), true);
  assert.equal(isTableCalcFormula('RUNNING_AVG([Profit])'), true);
  assert.equal(isTableCalcFormula('SUM([Sales])'), false);
});

test('requiresUserAgg ignores aggregations inside an LOD {} block', () => {
  assert.equal(requiresUserAggFromFormula('SUM([Sales])'), true);
  assert.equal(requiresUserAggFromFormula('{ FIXED [Region] : SUM([Sales]) }'), false);
  assert.equal(requiresUserAggFromFormula('[Sales] * 2'), false);
});

test('blended reference needs a multi-part bracket chain', () => {
  assert.equal(detectBlendedRef('[Orders].[Sales]'), true);
  assert.equal(detectBlendedRef('[Sales] + [Profit]'), false);
});

test('canonical id extracts Calculation_NNN from the FQN, keeps the caption as name', () => {
  const node = { __typename: 'CalculatedField', name: 'Margin %', fullyQualifiedName: '[Calculation_123]' };
  assert.equal(canonicalPulseIdentifier(node), 'Calculation_123');
});

test('classifier excludes table calcs, blends, and internals, and propagates through references', () => {
  const rows = classifyGraphqlNodes([
    { __typename: 'ColumnField', name: 'Sales', fullyQualifiedName: '[Sales]', role: 'MEASURE', dataType: 'REAL' },
    { __typename: 'CalculatedField', name: 'Rank', fullyQualifiedName: '[Calculation_1]', role: 'MEASURE', dataType: 'REAL', formula: 'RANK(SUM([Sales]))' },
    // References the table calc by name -> tainted table_calc even though its own
    // formula is not a table calc.
    { __typename: 'CalculatedField', name: 'RankPlus', fullyQualifiedName: '[Calculation_2]', role: 'MEASURE', dataType: 'REAL', formula: '[Rank] + 1' },
    { __typename: 'CalculatedField', name: 'Blend', fullyQualifiedName: '[Calculation_3]', role: 'MEASURE', dataType: 'REAL', formula: '[Orders].[Sales]' },
    { __typename: 'ColumnField', name: 'InternalObj', fullyQualifiedName: '[__tableau_internal_object_id__]', role: 'DIMENSION', dataType: 'STRING' },
    // Aggregate calc -> requiresUserAgg.
    { __typename: 'CalculatedField', name: 'Margin', fullyQualifiedName: '[Calculation_4]', role: 'MEASURE', dataType: 'REAL', formula: 'SUM([Profit])/SUM([Sales])' },
    // References an agg calc -> requiresUserAgg propagates.
    { __typename: 'CalculatedField', name: 'MarginX2', fullyQualifiedName: '[Calculation_5]', role: 'MEASURE', dataType: 'REAL', formula: '[Margin] * 2' },
  ]);

  assert.equal(byName(rows, 'Rank')?.exclusionHint, 'table_calc');
  assert.equal(byName(rows, 'RankPlus')?.exclusionHint, 'table_calc');
  assert.equal(byName(rows, 'Blend')?.exclusionHint, 'blend_ref');
  assert.equal(byName(rows, 'InternalObj')?.exclusionHint, 'internal');
  assert.equal(byName(rows, 'Sales')?.exclusionHint, null);

  assert.equal(byName(rows, 'Margin')?.requiresUserAggHint, true);
  assert.equal(byName(rows, 'MarginX2')?.requiresUserAggHint, true);
  assert.equal(byName(rows, 'Sales')?.requiresUserAggHint, false);

  // Canonical id survives as `name`; caption is the friendly name.
  assert.equal(byName(rows, 'Margin')?.name, 'Calculation_4');
});

test('hidden fields are omitted from selectable fields', () => {
  const rows = classifyGraphqlNodes([
    { __typename: 'ColumnField', name: 'Visible', fullyQualifiedName: '[Visible]', role: 'DIMENSION', dataType: 'STRING' },
    { __typename: 'ColumnField', name: 'Hidden', fullyQualifiedName: '[Hidden]', role: 'DIMENSION', dataType: 'STRING', isHidden: true },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caption, 'Visible');
});

test('metadata catalog parser terminates for malformed references and preserves quoted identifiers', () => {
  const formulas = ['[', '[A].[', "[Owner's Revenue] * 2", '[Revenue "Quoted"] * 2',
    "IF [Region] = 'West' THEN [Sales] END", "'[Other].[Sales]' + [Sales]",
    '// [Other].[Sales]\n[Sales]', '/* [Other].[Sales] */ [Sales]', '[Revenue // note] * 2', '[A].[B]'];
  const script = `
    import { fetchFieldsViaMetadataGraphql } from ${JSON.stringify(new URL('./metadata-fallback.ts', import.meta.url).href)};
    const formulas = ${JSON.stringify(formulas)};
    const results = [];
    for (const formula of formulas) {
      const nodes = ["Owner's Revenue", 'Revenue "Quoted"', 'Revenue // note'].map(name => ({ name, fullyQualifiedName: '[' + name + ']', formula: 'SUM([Sales])', role: 'MEASURE', dataType: 'REAL' }));
      nodes.push({ name: 'Wrapper', fullyQualifiedName: '[Wrapper]', formula, role: 'MEASURE', dataType: 'REAL' });
      globalThis.fetch = async () => Response.json({ data: { publishedDatasources: [{ fieldsConnection: { nodes } }] } });
      const catalog = await fetchFieldsViaMetadataGraphql({ serverUrl: 'https://test.invalid', siteContentUrl: '', siteId: 'site', userId: 'user', token: 'test', apiVersion: '3.27' }, 'ds', { luid: 'ds', name: 'DS' });
      results.push({ aggregate: catalog.measures.find(f => f.id === 'Wrapper')?.requiresUserAgg, excluded: catalog.excluded.some(f => f.field.id === 'Wrapper') });
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(child.error, undefined, `Metadata catalog pipeline exceeded watchdog: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  for (const index of [2, 3, 8]) assert.equal(results[index].aggregate, true, formulas[index]);
  for (const index of [4, 5, 6, 7]) assert.equal(results[index].excluded, false, formulas[index]);
  assert.equal(results[9].excluded, true);
});

test('final metadata catalog propagates hidden dependencies without exposing their fields', async () => {
  const node = (name: string, formula?: string, isHidden = false) => ({ name, fullyQualifiedName: `[${name}]`, role: 'MEASURE', dataType: 'REAL', formula, isHidden });
  const nodes = [node('Sales', undefined, true), node('Rank', 'RANK(SUM([Sales]))', true),
    node('RankPlus', '[Rank] + 1'), node('RankTwice', '[RankPlus] * 2'),
    node('Margin', 'SUM([Profit])/SUM([Sales])', true), node('MarginX2', '[Margin] * 2'),
    node('MarginX4', '[MarginX2] * 2'), node('RowLevel', '[Sales] * 2')];
  globalThis.fetch = async () => Response.json({ data: { publishedDatasources: [{ fieldsConnection: { nodes } }] } });
  const catalog = await fetchFieldsViaMetadataGraphql(session(), 'ds', { luid: 'ds', name: 'DS' });
  for (const id of ['RankPlus', 'RankTwice']) assert.ok(catalog.excluded.some(({ field, reason }) => field.id === id && reason === 'table_calc'));
  for (const id of ['MarginX2', 'MarginX4']) assert.equal(catalog.measures.find((field) => field.id === id)?.requiresUserAgg, true);
  assert.equal(catalog.measures.find((field) => field.id === 'RowLevel')?.requiresUserAgg, false);
  const all = [...catalog.measures, ...catalog.dimensions, ...catalog.timeDimensions, ...catalog.excluded.map(({ field }) => field)];
  assert.ok(all.every((field) => !['Sales', 'Rank', 'Margin'].includes(field.id)));
});

test('fetchFieldsViaMetadataGraphql paginates and sends $luid as String!', async () => {
  const bodies: any[] = [];
  let call = 0;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    call += 1;
    if (call === 1) {
      return Response.json({
        data: {
          publishedDatasources: [
            {
              luid: 'ds', name: 'Paged DS',
              fieldsConnection: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
                nodes: [{ __typename: 'ColumnField', name: 'Order Date', fullyQualifiedName: '[Order Date]', role: 'DIMENSION', dataType: 'DATE' }],
              },
            },
          ],
        },
      });
    }
    return Response.json({
      data: {
        publishedDatasources: [
          {
            luid: 'ds', name: 'Paged DS',
            fieldsConnection: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ __typename: 'ColumnField', name: 'Sales', fullyQualifiedName: '[Sales]', role: 'MEASURE', dataType: 'REAL' }],
            },
          },
        ],
      },
    });
  };

  const catalog = await fetchFieldsViaMetadataGraphql(session(), 'ds-luid', { luid: 'ds-luid', name: 'fallback name' });

  assert.equal(call, 2, 'should follow the cursor to the second page');
  assert.match(bodies[0].query, /\$luid:\s*String!/);
  assert.equal(bodies[0].variables.after, null);
  assert.equal(bodies[1].variables.after, 'CUR1');
  assert.equal(catalog.source, 'metadata');
  assert.equal(catalog.datasourceName, 'Paged DS');
  assert.equal(catalog.measures.find((m) => m.id === 'Sales')?.caption, 'Sales');
  assert.equal(catalog.timeDimensions.find((d) => d.id === 'Order Date')?.caption, 'Order Date');
});
