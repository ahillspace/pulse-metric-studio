import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { TableauSession } from './rest-client.js';
import { getFieldCatalog, getLoadedFieldCatalog, invalidateFieldsCache } from './vds-fields.js';

const datasourceLuid = '11111111-1111-1111-1111-111111111111';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateFieldsCache();
});

function session(serverUrl: string, siteId: string, userId: string, token: string): TableauSession {
  return {
    serverUrl,
    siteContentUrl: '',
    siteId,
    userId,
    token,
    apiVersion: '3.27',
  };
}

test('field catalog cache isolates server, site, and user while excluding credentials', async () => {
  const sessions = [
    session('https://one.example.test', 'site-1', 'user-1', 'token-a'),
    session('https://two.example.test', 'site-1', 'user-1', 'token-b'),
    session('https://one.example.test', 'site-2', 'user-1', 'token-c'),
    session('https://one.example.test', 'site-1', 'user-2', 'token-d'),
  ];
  let requestCount = 0;

  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    const token = new Headers(init?.headers).get('X-Tableau-Auth') ?? 'missing';
    if (init?.method === 'GET') {
      return Response.json({
        datasources: { datasource: [{ id: datasourceLuid, name: `Datasource ${token}` }] },
      });
    }
    return Response.json({
      data: [{
        fieldName: `date_${token}`,
        fieldCaption: `Date ${token}`,
        dataType: 'DATE',
        fieldType: 'DATE',
        fieldRole: 'DIMENSION',
        logicalTableId: 'table-1',
      }],
    });
  };

  const catalogs = [];
  for (const activeSession of sessions) {
    catalogs.push(await getFieldCatalog(activeSession, datasourceLuid));
  }
  assert.equal(requestCount, 8);
  assert.deepEqual(catalogs.map((catalog) => catalog.timeDimensions[0]?.id), [
    'date_token-a',
    'date_token-b',
    'date_token-c',
    'date_token-d',
  ]);

  const refreshedCredential = { ...sessions[0], token: 'replacement-secret' };
  const cached = await getFieldCatalog(refreshedCredential, datasourceLuid);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.timeDimensions[0]?.id, 'date_token-a');
  assert.equal(requestCount, 8);

  globalThis.fetch = async () => { throw new Error('Metadata network unavailable'); };
  assert.equal(getLoadedFieldCatalog(sessions[0]!, datasourceLuid)?.timeDimensions[0]?.id, 'date_token-a');
  assert.equal(getLoadedFieldCatalog({ ...sessions[0]!, siteId: 'wrong-owner' }, datasourceLuid), undefined);
});

test('catalog carries the exact Tableau caption for calc fields while label dedups', async () => {
  const activeSession = session('https://cap.example.test', 'site-1', 'user-1', 'token-cap');
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') {
      return Response.json({ datasources: { datasource: [{ id: datasourceLuid, name: 'Orders' }] } });
    }
    return Response.json({
      data: [
        {
          fieldName: 'Calculation_123456789',
          fieldCaption: 'Average Deal Cycle',
          dataType: 'REAL',
          fieldRole: 'MEASURE',
          columnClass: 'CALCULATION',
          formula: "AVG(DATEDIFF('day',[Order Date],[Ship Date]))",
          logicalTableId: 'Orders_ABCDEF01',
        },
        {
          fieldName: 'order_date',
          fieldCaption: 'Order Date',
          dataType: 'DATE',
          fieldRole: 'DIMENSION',
          logicalTableId: 'Orders_ABCDEF01',
        },
      ],
    });
  };

  const catalog = await getFieldCatalog(activeSession, datasourceLuid);
  const calc = catalog.measures.find((m) => m.id === 'Calculation_123456789');
  assert.ok(calc, 'expected the calc measure to be catalogued');
  // Raw internal id is unresolvable by Pulse; caption is the human name.
  assert.equal(calc?.name, 'Calculation_123456789');
  assert.equal(calc?.caption, 'Average Deal Cycle');
  const orderDate = catalog.timeDimensions.find((d) => d.id === 'order_date');
  assert.equal(orderDate?.caption, 'Order Date');
});

test('VDS columnClass drives calc classification: TABLE_CALCULATION excluded, agg calc requires user agg', async () => {
  const activeSession = session('https://cc.example.test', 'site-1', 'user-1', 'token-cc');
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') {
      return Response.json({ datasources: { datasource: [{ id: datasourceLuid, name: 'Sales' }] } });
    }
    return Response.json({
      data: [
        { fieldName: 'order_date', fieldCaption: 'Order Date', dataType: 'DATE', fieldRole: 'DIMENSION', logicalTableId: 't' },
        // Nested table calc: formula carries NO table-calc keyword, only a
        // reference — VDS still flags it TABLE_CALCULATION. Must be excluded.
        {
          fieldName: 'Calculation_nested',
          fieldCaption: 'Nested Rank Wrapper',
          dataType: 'REAL',
          fieldRole: 'MEASURE',
          columnClass: 'TABLE_CALCULATION',
          defaultAggregation: 'AGG',
          formula: '[Some Rank] + 1',
          logicalTableId: 't',
        },
        // Aggregate calc: VDS reports AGG -> must publish with user agg.
        {
          fieldName: 'Calculation_margin',
          fieldCaption: 'Margin %',
          dataType: 'REAL',
          fieldRole: 'MEASURE',
          columnClass: 'CALCULATION',
          defaultAggregation: 'AGG',
          formula: 'SUM([Profit])/SUM([Sales])',
          logicalTableId: 't',
        },
        // Row-level constant calc: bare SUM aggregation -> we aggregate it.
        {
          fieldName: 'Calculation_const',
          fieldCaption: 'Flat Fee',
          dataType: 'INTEGER',
          fieldRole: 'MEASURE',
          columnClass: 'CALCULATION',
          defaultAggregation: 'SUM',
          formula: '75',
          logicalTableId: 't',
        },
        { fieldName: 'sales_bucket', fieldCaption: 'Sales (bin)', dataType: 'INTEGER', fieldRole: 'DIMENSION', columnClass: 'BIN', logicalTableId: 't' },
        { fieldName: 'secret', fieldCaption: 'Secret', dataType: 'STRING', fieldRole: 'DIMENSION', isHidden: true, logicalTableId: 't' },
      ],
    });
  };

  const catalog = await getFieldCatalog(activeSession, datasourceLuid);

  const excludedReason = (id: string) => catalog.excluded.find((e) => e.field.id === id)?.reason;
  assert.equal(excludedReason('Calculation_nested'), 'table_calc');
  assert.equal(excludedReason('sales_bucket'), 'bin');
  assert.equal(excludedReason('secret'), 'internal');

  const margin = catalog.measures.find((m) => m.id === 'Calculation_margin');
  assert.ok(margin, 'aggregate calc should be an available measure');
  assert.equal(margin?.requiresUserAgg, true);

  const flatFee = catalog.measures.find((m) => m.id === 'Calculation_const');
  assert.ok(flatFee, 'constant calc should be an available measure');
  assert.equal(flatFee?.requiresUserAgg, false);
});

test('sqlproxy caption edge case is repaired from the Metadata API friendly name', async () => {
  const activeSession = session('https://sqlproxy.example.test', 'site-1', 'user-1', 'token-sp');
  let graphqlCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') {
      return Response.json({ datasources: { datasource: [{ id: datasourceLuid, name: 'Federated' }] } });
    }
    if (url.includes('metadata/graphql')) {
      graphqlCalls += 1;
      return Response.json({
        data: {
          publishedDatasources: [
            {
              luid: datasourceLuid,
              name: 'Federated',
              fieldsConnection: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: 'CalculatedField',
                    id: 'x',
                    name: 'Margin %',
                    fullyQualifiedName: '[Calculation_0014334541414402]',
                    formula: 'SUM([Profit])/SUM([Sales])',
                    role: 'MEASURE',
                    dataType: 'REAL',
                  },
                ],
              },
            },
          ],
        },
      });
    }
    // read-metadata: VDS returns the internal id as BOTH name and caption.
    return Response.json({
      data: [
        { fieldName: 'order_date', fieldCaption: 'Order Date', dataType: 'DATE', fieldRole: 'DIMENSION', logicalTableId: 't' },
        {
          fieldName: 'Calculation_0014334541414402',
          fieldCaption: 'Calculation_0014334541414402',
          dataType: 'REAL',
          fieldRole: 'MEASURE',
          columnClass: 'CALCULATION',
          defaultAggregation: 'AGG',
          formula: 'SUM([Profit])/SUM([Sales])',
          logicalTableId: 't',
        },
      ],
    });
  };

  const catalog = await getFieldCatalog(activeSession, datasourceLuid);
  assert.equal(graphqlCalls, 1, 'enrichment should hit the Metadata API exactly once');
  const calc = catalog.measures.find((m) => m.id === 'Calculation_0014334541414402');
  assert.ok(calc, 'calc should still be catalogued');
  // id/name stay the raw identifier Pulse resolves by; caption/label repaired.
  assert.equal(calc?.name, 'Calculation_0014334541414402');
  assert.equal(calc?.caption, 'Margin %');
  assert.equal(calc?.label, 'Margin %');
});

test('caption enrichment is not attempted when no calc caption is an internal id', async () => {
  const activeSession = session('https://noenrich.example.test', 'site-1', 'user-1', 'token-ne');
  let graphqlCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('metadata/graphql')) graphqlCalls += 1;
    if (init?.method === 'GET') {
      return Response.json({ datasources: { datasource: [{ id: datasourceLuid, name: 'Clean' }] } });
    }
    return Response.json({
      data: [
        { fieldName: 'order_date', fieldCaption: 'Order Date', dataType: 'DATE', fieldRole: 'DIMENSION', logicalTableId: 't' },
        { fieldName: 'Calculation_9', fieldCaption: 'Profit Ratio', dataType: 'REAL', fieldRole: 'MEASURE', columnClass: 'CALCULATION', defaultAggregation: 'AGG', logicalTableId: 't' },
      ],
    });
  };

  await getFieldCatalog(activeSession, datasourceLuid);
  assert.equal(graphqlCalls, 0, 'no unresolved calc caption -> no Metadata API call');
});

test('datasource invalidation clears every session boundary for that datasource', async () => {
  const first = session('https://one.example.test', 'site-1', 'user-1', 'token-a');
  const second = session('https://two.example.test', 'site-2', 'user-2', 'token-b');
  let requestCount = 0;

  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    if (init?.method === 'GET') {
      return Response.json({ datasources: { datasource: [{ id: datasourceLuid, name: 'Datasource' }] } });
    }
    return Response.json({
      data: [{
        fieldName: 'order_date',
        dataType: 'DATE',
        fieldRole: 'DIMENSION',
        logicalTableId: 'table-1',
      }],
    });
  };

  await getFieldCatalog(first, datasourceLuid);
  await getFieldCatalog(second, datasourceLuid);
  assert.equal(requestCount, 4);

  invalidateFieldsCache(datasourceLuid);
  await getFieldCatalog(first, datasourceLuid);
  await getFieldCatalog(second, datasourceLuid);
  assert.equal(requestCount, 8);
});
