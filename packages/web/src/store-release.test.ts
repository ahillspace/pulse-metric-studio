import assert from 'node:assert/strict';
import test from 'node:test';
import { OpsSchema, type AuthorResponse, type CatalogField, type DatasourceCatalog } from '@pulse-metric-studio/shared';
import { buildCreatePayloads } from './features/pulse/lib/payloads';
import { api } from './api/client';
import { useStore } from './store';

const field = (id: string, dataType = 'REAL'): CatalogField => ({ id, name: id, caption: id, label: id, role: dataType === 'REAL' ? 'MEASURE' : 'DIMENSION', dataType, table: 'Orders', defaultAggregation: 'SUM', formula: null, requiresUserAgg: false });
const catalog: DatasourceCatalog = { datasourceLuid: 'a', datasourceName: 'A', measures: [field('Sales')], dimensions: [field('Region', 'STRING')], timeDimensions: [{ ...field('Order Date', 'DATE'), timeType: 'DATE' }, { ...field('Ship Date', 'DATE'), timeType: 'DATE' }], parameters: [], excluded: [], source: 'vds', warnings: [] };
const sources = [{ luid: 'a', name: 'A', projectName: '' }, { luid: 'b', name: 'B', projectName: '' }];
function reset() { useStore.setState({ ...useStore.getInitialState(), connected: true, session: { serverUrl: 'https://tableau.example', siteId: 'site', siteContentUrl: 'site', userId: 'user' }, selectedDs: sources[0], datasources: sources, catalog }); }
const reply: AuthorResponse = { ops: [{ op: 'ADD_METRIC', fieldId: 'Sales', name: 'Stale' }], assistantMessage: 'Stale reply', digestAudience: 'Stale audience', model: 'test', provider: 'test', warnings: [] };

test('accepted short granularity, manual date lock, and cumulative patch survive real store operations', () => {
  reset();
  useStore.getState().applyOps([OpsSchema.parse({ op: 'ADD_METRIC', fieldId: 'Sales', minGranularity: 'MONTH', cumulative: true, temporality: 'OVER_TIME' })], '');
  assert.equal(useStore.getState().metrics.Sales.minGranularity, 'MONTH');
  assert.equal(useStore.getState().metrics.Sales.cumulative, true);
  useStore.setState({ metrics: { Sales: { ...useStore.getState().metrics.Sales, timeDimensionFieldId: 'Ship Date', locks: ['timeDimensionFieldId'] } } });
  useStore.getState().applyOps([{ op: 'MODIFY_METRIC', fieldId: 'Sales', timeDimensionFieldId: 'Order Date' }], '');
  assert.equal(useStore.getState().metrics.Sales.timeDimensionFieldId, 'Ship Date');
});

test('late author completion after clear cannot change the actual editor', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: (value: AuthorResponse) => void;
  t.mock.method(api, 'author', () => new Promise<AuthorResponse>((done) => { resolve = done; }));
  t.mock.method(api, 'saveDraft', async () => ({ ok: true }));
  const pending = useStore.getState().sendChat('Design metrics');
  useStore.getState().clearAll();
  resolve(reply);
  await pending;
  assert.deepEqual(useStore.getState().metrics, {});
  assert.deepEqual(useStore.getState().chat, []);
});

test('autosave snapshots A before navigation to B', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved: Array<{ luid: string; draft: any }> = [];
  t.mock.method(api, 'saveDraft', async (luid: string, draft: unknown) => { saved.push({ luid, draft }); return { ok: true }; });
  useStore.getState().toggleMetric('Sales');
  useStore.setState({ selectedDs: sources[1], metrics: {}, chat: [], digestAudience: 'B audience' });
  t.mock.timers.tick(601);
  await useStore.getState().retryDraftSaves();
  assert.equal(saved[0].luid, 'a');
  assert.equal(saved[0].draft.datasourceName, 'A');
  assert.ok(saved[0].draft.metrics.Sales);
});

for (const gran of ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']) {
  for (const alias of [gran, `GRANULARITY_BY_${gran}`]) {
    test(`schema to actual store to payload preserves ${alias}`, () => {
      reset();
      useStore.getState().applyOps([OpsSchema.parse({ op: 'ADD_METRIC', fieldId: 'Sales', timeDimensionFieldId: 'Order Date', minGranularity: alias }), { op: 'ADD_SLICER', fieldId: 'Region' }], '');
      const state = useStore.getState();
      const payloads = buildCreatePayloads({ catalog, metrics: state.metrics, slicers: state.slicers });
      assert.equal(state.metrics.Sales.minGranularity, gran);
      assert.equal((payloads[0] as any).extension_options.allowed_granularities[0], `GRANULARITY_BY_${gran}`);
      state.applyOps([{ op: 'MODIFY_METRIC', fieldId: 'Sales', description: 'Updated' }], '');
      assert.equal(useStore.getState().metrics.Sales.minGranularity, gran);
    });
  }
}
for (const op of ['ADD_METRIC', 'MODIFY_METRIC'] as const) {
  for (const cumulative of [true, false]) {
    test(`${op} merges cumulative=${cumulative} before enforcing temporality and locks`, (t) => {
      reset();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const store = useStore.getState();
      store.applyOps([{ op: 'ADD_METRIC', fieldId: 'Sales', cumulative: !cumulative }], '');
      store.applyOps([{ op, fieldId: 'Sales', cumulative, temporality: 'OVER_TIME' }], '');
      assert.equal(useStore.getState().metrics.Sales.cumulative, cumulative);
      store.updateMetric('Sales', { timeDimensionFieldId: 'Ship Date' });
      store.applyOps([{ op, fieldId: 'Sales', timeDimensionFieldId: 'Order Date' }], '');
      assert.equal(useStore.getState().metrics.Sales.timeDimensionFieldId, 'Ship Date');
      useStore.setState({ metrics: { Sales: { ...useStore.getState().metrics.Sales, locks: [] } } });
      store.applyOps([{ op, fieldId: 'Sales', timeDimensionFieldId: 'Order Date', cumulative: true, temporality: 'LATEST' }], '');
      assert.equal(useStore.getState().metrics.Sales.timeDimensionFieldId, 'Order Date');
      assert.equal(useStore.getState().metrics.Sales.cumulative, false);
      store.applyOps([{ op, fieldId: 'Sales', cumulative: true, temporality: 'OVER_TIME', format: 'PERCENT' }], '');
      assert.equal(useStore.getState().metrics.Sales.cumulative, false);
    });
  }
}

test('deferred A author success cannot clear B busy state or change B editor', async (t) => {
  reset();
  let finishA!: (value: AuthorResponse) => void;
  let finishB!: (value: AuthorResponse) => void;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(api, 'author', () => new Promise<AuthorResponse>((done) => { if (!finishA) finishA = done; else finishB = done; }));
  t.mock.method(api, 'fields', async () => ({ catalog: { ...catalog, datasourceLuid: 'b' } }));
  t.mock.method(api, 'loadDraft', async () => ({ draft: null }));
  t.mock.method(api, 'existingMetrics', async () => ({ definitions: [] }));
  t.mock.method(api, 'runs', async () => ({ runs: [] }));
  const a = useStore.getState().sendChat('A request');
  await useStore.getState().selectDatasource('b');
  const b = useStore.getState().sendChat('B request');
  const before = useStore.getState();
  finishA(reply); await a;
  const after = useStore.getState();
  for (const key of ['metrics', 'slicers', 'chat', 'digestAudience', 'chatBusy', 'draftSaves'] as const) assert.deepEqual(after[key], before[key]);
  finishB({ ...reply, ops: [], assistantMessage: 'B reply' }); await b;
});

test('stale author error after clear does not replace newer request status', async (t) => {
  reset();
  let reject!: (error: Error) => void;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(api, 'author', () => new Promise<AuthorResponse>((_resolve, fail) => { reject = fail; }));
  const pending = useStore.getState().sendChat('A request');
  useStore.getState().clearAll();
  useStore.setState({ chatBusy: true, toast: null });
  reject(new Error('Stale failure')); await pending;
  assert.equal(useStore.getState().chatBusy, true);
  assert.equal(useStore.getState().toast, null);
});

test('reselecting the same datasource invalidates its previous author request', async (t) => {
  reset();
  let finish!: (response: AuthorResponse) => void;
  t.mock.method(api, 'author', () => new Promise<AuthorResponse>((done) => { finish = done; }));
  t.mock.method(api, 'fields', async () => ({ catalog }));
  t.mock.method(api, 'loadDraft', async () => ({ draft: null }));
  t.mock.method(api, 'existingMetrics', async () => ({ definitions: [] }));
  t.mock.method(api, 'runs', async () => ({ runs: [] }));
  const request = useStore.getState().sendChat('Old lifetime');
  await useStore.getState().selectDatasource('a');
  finish(reply); await request;
  assert.deepEqual(useStore.getState().metrics, {});
  assert.deepEqual(useStore.getState().chat, []);
});

test('clear does not strand an in-flight history lookup', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: (value: { runs: [] }) => void;
  t.mock.method(api, 'runs', () => new Promise<{ runs: [] }>((done) => { finish = done; }));
  const pending = useStore.getState().loadRunHistory();
  useStore.getState().clearAll();
  finish({ runs: [] }); await pending;
  assert.equal(useStore.getState().runHistoryLoading, false);
});

test('latest receipt selection wins over a slower earlier lookup', async (t) => {
  reset();
  let finish!: (value: any) => void;
  const receipt = (runId: string) => ({ runId, results: [], createdCount: 0, failedCount: 0, createdAt: 1, datasourceLuid: 'a', datasourceName: 'A' });
  t.mock.method(api, 'run', (runId: string) => runId === 'old' ? new Promise((done) => { finish = done; }) : Promise.resolve(receipt(runId)));
  const first = useStore.getState().openRun('old');
  await useStore.getState().openRun('latest');
  finish(receipt('old')); await first;
  assert.equal(useStore.getState().lastRun?.runId, 'latest');
});

test('all-failed undo retains retryable receipt and completed retry keeps durable receipt', async (t) => {
  reset();
  const receipt = { runId: 'run', results: [{ itemIndex: 0, name: 'Sales', status: 'created' as const, definitionId: 'definition', undoStatus: 'pending' as 'pending' | 'failed' | 'deleted' }], createdCount: 1, failedCount: 0, createdAt: 1, datasourceLuid: 'a', datasourceName: 'A' };
  useStore.setState({ lastRun: receipt });
  let failed = true;
  t.mock.method(api, 'undoRun', async () => ({ definitionsDeleted: failed ? 0 : 1, metricsDeleted: 0, failures: failed ? ['Forbidden'] : [], outcomes: [], run: { ...receipt, results: receipt.results.map((item) => ({ ...item, undoStatus: failed ? 'failed' : 'deleted' })) } }));
  t.mock.method(api, 'existingMetrics', async () => ({ definitions: [] }));
  t.mock.method(api, 'runs', async () => ({ runs: [] }));
  await useStore.getState().undoRun();
  assert.equal(useStore.getState().toast?.tone, 'warning');
  assert.equal(useStore.getState().lastRun?.results[0].undoStatus, 'failed');
  failed = false;
  await useStore.getState().undoRun();
  assert.equal(useStore.getState().toast?.tone, 'success');
  assert.equal(useStore.getState().lastRun?.results[0].undoStatus, 'deleted');
});

for (const transition of ['disconnect', 'connection switch'] as const) {
  test(`late author completion after ${transition} cannot mutate the new context`, async (t) => {
    reset();
    let finish!: (value: AuthorResponse) => void;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(api, 'author', () => new Promise<AuthorResponse>((done) => { finish = done; }));
    t.mock.method(api, 'disconnect', async () => ({ ok: true }));
    t.mock.method(api, 'saveDraft', async () => ({ ok: true }));
    const pending = useStore.getState().sendChat('Old connection');
    if (transition === 'disconnect') await useStore.getState().disconnect();
    else useStore.setState({ session: { serverUrl: 'https://other.example', siteId: 'other', siteContentUrl: 'other', userId: 'other' } });
    const before = useStore.getState();
    finish(reply); await pending;
    for (const key of ['metrics', 'slicers', 'chat', 'digestAudience', 'chatBusy', 'draftSaves', 'toast'] as const) assert.deepEqual(useStore.getState()[key], before[key]);
  });
}

test('starting undo invalidates an already pending receipt lookup', async (t) => {
  reset();
  const receipt = { runId: 'current', results: [{ name: 'Sales', status: 'created' as const, definitionId: 'def', undoStatus: 'pending' as const }], createdCount: 1, failedCount: 0, createdAt: 1, datasourceLuid: 'a', datasourceName: 'A' };
  let finish!: (value: any) => void;
  t.mock.method(api, 'run', () => new Promise((done) => { finish = done; }));
  t.mock.method(api, 'undoRun', async () => ({ definitionsDeleted: 1, metricsDeleted: 0, failures: [], outcomes: [], run: { ...receipt, results: [{ ...receipt.results[0], undoStatus: 'deleted' }] } }));
  t.mock.method(api, 'existingMetrics', async () => ({ definitions: [] }));
  t.mock.method(api, 'runs', async () => ({ runs: [] }));
  useStore.setState({ selectedDs: sources[0], catalog, lastRun: receipt });
  const pending = useStore.getState().openRun('old');
  await useStore.getState().undoRun();
  finish({ ...receipt, runId: 'old' }); await pending;
  assert.equal(useStore.getState().lastRun?.runId, 'current');
  assert.equal(useStore.getState().lastRun?.results[0].undoStatus, 'deleted');
});
