import assert from 'node:assert/strict';
import test from 'node:test';
import type { BuilderDraft, DatasourceCatalog, MetricSelection } from '@pulse-metric-studio/shared';
import {
  api,
  type ExistingMetricsResponse,
  type FollowState,
} from './api/client.js';
import { useStore, type DsInfo } from './store.js';

const datasourceA: DsInfo = { luid: 'datasource-a', name: 'Datasource A', projectName: 'Project' };
const datasourceB: DsInfo = { luid: 'datasource-b', name: 'Datasource B', projectName: 'Project' };

function catalog(luid: string): DatasourceCatalog {
  return {
    datasourceLuid: luid,
    datasourceName: luid === datasourceA.luid ? datasourceA.name : datasourceB.name,
    measures: [],
    dimensions: [],
    timeDimensions: [],
    parameters: [],
    excluded: [],
    source: 'vds',
    warnings: [],
  };
}

function emptyInventory(): ExistingMetricsResponse {
  return { definitions: [], totalScanned: 0, truncated: false };
}

function metric(fieldId: string): MetricSelection {
  return {
    active: true,
    fieldId,
    fieldLabel: fieldId,
    requiresUserAgg: false,
    aggregation: 'SUM',
    cumulative: false,
    format: 'NUMBER',
    sentiment: 'NONE',
    name: fieldId,
    description: '',
    timeDimensionFieldId: null,
    minGranularity: '',
    temporality: 'OVER_TIME',
    locks: [],
  };
}

function draft(luid: string): BuilderDraft {
  return {
    version: 1,
    datasourceLuid: luid,
    datasourceName: datasourceA.name,
    digestAudience: 'Datasource A audience',
    digestAudienceLocked: true,
    groupFollow: true,
    metrics: { metricA: metric('metricA') },
    slicers: { slicerA: { active: true, fieldId: 'slicerA', fieldLabel: 'Slicer A' } },
    chat: [{ role: 'assistant', content: 'Datasource A draft', ts: 1 }],
    updatedAt: 1,
  };
}

function inventory(metricId: string): ExistingMetricsResponse {
  return {
    definitions: [{
      definitionId: `definition-${metricId}`,
      name: `Definition ${metricId}`,
      description: '',
      measure: 'Sales',
      aggregation: 'SUM',
      timeDimension: 'Order Date',
      metrics: [{
        metricId,
        name: `Metric ${metricId}`,
        measurementPeriod: {},
        timeframeLabel: 'Current',
      }],
    }],
    totalScanned: 1,
    truncated: false,
  };
}

function availableFollowState(metricId: string): FollowState {
  return {
    userFollowsByMetricId: { [metricId]: true },
    groupFollowsByMetricId: {},
    followerCountsByMetricId: { [metricId]: 1 },
    errors: [],
    availabilityByMetricId: {
      [metricId]: {
        status: 'available',
        relationshipStatus: 'available',
        followerCountStatus: 'available',
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('a stale inventory response cannot overwrite the newly selected datasource', async () => {
  const originalExistingMetrics = api.existingMetrics;
  const pendingInventory = deferred<ExistingMetricsResponse>();
  api.existingMetrics = async () => pendingInventory.promise;
  try {
    useStore.setState({
      selectedDs: datasourceA,
      existing: null,
      existingLoading: false,
      followState: null,
      toast: null,
    });
    const load = useStore.getState().loadExisting();
    assert.equal(useStore.getState().existingLoading, true);

    const inventoryB = inventory('metric-b');
    const followStateB = availableFollowState('metric-b');
    const toastB = { tone: 'info' as const, message: 'Datasource B selected', id: 9001 };
    useStore.setState({
      selectedDs: datasourceB,
      existing: inventoryB,
      existingLoading: false,
      followState: followStateB,
      toast: toastB,
    });
    pendingInventory.resolve(inventory('metric-a'));
    await load;

    assert.equal(useStore.getState().selectedDs?.luid, datasourceB.luid);
    assert.equal(useStore.getState().existing, inventoryB);
    assert.equal(useStore.getState().followState, followStateB);
    assert.equal(useStore.getState().toast, toastB);
    assert.equal(useStore.getState().existingLoading, false);
  } finally {
    api.existingMetrics = originalExistingMetrics;
  }
});

test('a stale follow-state response cannot overwrite the newly selected datasource', async () => {
  const originalExistingMetrics = api.existingMetrics;
  const originalFollowState = api.followState;
  const pendingFollowState = deferred<FollowState>();
  const followStarted = deferred<void>();
  api.existingMetrics = async () => inventory('metric-a');
  api.followState = async () => {
    followStarted.resolve();
    return pendingFollowState.promise;
  };
  try {
    useStore.setState({
      selectedDs: datasourceA,
      existing: null,
      existingLoading: false,
      followState: null,
      toast: null,
    });
    const load = useStore.getState().loadExisting();
    await followStarted.promise;

    const inventoryB = inventory('metric-b');
    const followStateB = availableFollowState('metric-b');
    const toastB = { tone: 'info' as const, message: 'Datasource B selected', id: 9002 };
    useStore.setState({
      selectedDs: datasourceB,
      existing: inventoryB,
      existingLoading: false,
      followState: followStateB,
      toast: toastB,
    });
    pendingFollowState.resolve(availableFollowState('metric-a'));
    await load;

    assert.equal(useStore.getState().selectedDs?.luid, datasourceB.luid);
    assert.equal(useStore.getState().existing, inventoryB);
    assert.equal(useStore.getState().followState, followStateB);
    assert.equal(useStore.getState().toast, toastB);
  } finally {
    api.existingMetrics = originalExistingMetrics;
    api.followState = originalFollowState;
  }
});

test('a stale field response cannot overwrite the newly selected datasource', async () => {
  const originalFields = api.fields;
  const originalLoadDraft = api.loadDraft;
  const originalExistingMetrics = api.existingMetrics;
  const pendingFieldsA = deferred<{ catalog: DatasourceCatalog }>();
  const catalogB = catalog(datasourceB.luid);
  api.fields = async (luid) => (
    luid === datasourceA.luid ? pendingFieldsA.promise : { catalog: catalogB }
  );
  api.loadDraft = async () => ({ draft: null, updatedAt: 0 });
  api.existingMetrics = async () => emptyInventory();
  try {
    useStore.setState({
      datasources: [datasourceA, datasourceB],
      selectedDs: null,
      catalog: null,
      catalogLoading: false,
      metrics: {},
      slicers: {},
      chat: [],
      hasGeneratedDraft: false,
      existing: null,
      existingLoading: false,
      followState: null,
      toast: null,
    });

    const selectA = useStore.getState().selectDatasource(datasourceA.luid);
    const selectB = useStore.getState().selectDatasource(datasourceB.luid);
    await selectB;
    const toastB = useStore.getState().toast;

    pendingFieldsA.resolve({ catalog: catalog(datasourceA.luid) });
    await selectA;

    assert.equal(useStore.getState().selectedDs?.luid, datasourceB.luid);
    assert.equal(useStore.getState().catalog, catalogB);
    assert.deepEqual(useStore.getState().metrics, {});
    assert.deepEqual(useStore.getState().slicers, {});
    assert.deepEqual(useStore.getState().chat, []);
    assert.equal(useStore.getState().catalogLoading, false);
    assert.equal(useStore.getState().toast, toastB);
  } finally {
    api.fields = originalFields;
    api.loadDraft = originalLoadDraft;
    api.existingMetrics = originalExistingMetrics;
  }
});

test('a stale draft response cannot overwrite the newly selected datasource', async () => {
  const originalFields = api.fields;
  const originalLoadDraft = api.loadDraft;
  const originalExistingMetrics = api.existingMetrics;
  const pendingDraftA = deferred<{ draft: unknown; updatedAt: number }>();
  const draftStarted = deferred<void>();
  const catalogB = catalog(datasourceB.luid);
  api.fields = async (luid) => ({ catalog: luid === datasourceA.luid ? catalog(datasourceA.luid) : catalogB });
  api.loadDraft = async (luid) => {
    if (luid === datasourceA.luid) {
      draftStarted.resolve();
      return pendingDraftA.promise;
    }
    return { draft: null, updatedAt: 0 };
  };
  api.existingMetrics = async () => emptyInventory();
  try {
    useStore.setState({
      datasources: [datasourceA, datasourceB],
      selectedDs: null,
      catalog: null,
      catalogLoading: false,
      metrics: {},
      slicers: {},
      digestAudience: 'Datasource B audience',
      digestAudienceLocked: false,
      groupFollow: false,
      chat: [],
      hasGeneratedDraft: false,
      existing: null,
      existingLoading: false,
      followState: null,
      toast: null,
    });

    const selectA = useStore.getState().selectDatasource(datasourceA.luid);
    await draftStarted.promise;
    const selectB = useStore.getState().selectDatasource(datasourceB.luid);
    await selectB;
    const toastB = useStore.getState().toast;

    pendingDraftA.resolve({ draft: draft(datasourceA.luid), updatedAt: 1 });
    await selectA;

    assert.equal(useStore.getState().selectedDs?.luid, datasourceB.luid);
    assert.equal(useStore.getState().catalog, catalogB);
    assert.deepEqual(useStore.getState().metrics, {});
    assert.deepEqual(useStore.getState().slicers, {});
    assert.equal(useStore.getState().digestAudience, '');
    assert.equal(useStore.getState().digestAudienceLocked, false);
    assert.equal(useStore.getState().groupFollow, true);
    assert.deepEqual(useStore.getState().chat, []);
    assert.equal(useStore.getState().hasGeneratedDraft, false);
    assert.equal(useStore.getState().catalogLoading, false);
    assert.equal(useStore.getState().toast, toastB);
  } finally {
    api.fields = originalFields;
    api.loadDraft = originalLoadDraft;
    api.existingMetrics = originalExistingMetrics;
  }
});

test('an older refresh response cannot overwrite a newer refresh response', async () => {
  const originalFields = api.fields;
  const olderRefresh = deferred<{ catalog: DatasourceCatalog }>();
  const newerRefresh = deferred<{ catalog: DatasourceCatalog }>();
  const oldCatalog = catalog(datasourceA.luid);
  const newCatalog = { ...catalog(datasourceA.luid), source: 'metadata' as const };
  let refreshCount = 0;
  api.fields = async (_luid, refresh) => {
    assert.equal(refresh, true);
    refreshCount += 1;
    return refreshCount === 1 ? olderRefresh.promise : newerRefresh.promise;
  };
  try {
    useStore.setState({
      selectedDs: datasourceA,
      catalog: null,
      catalogLoading: false,
      toast: null,
    });

    const firstRefresh = useStore.getState().refreshFields();
    const secondRefresh = useStore.getState().refreshFields();
    newerRefresh.resolve({ catalog: newCatalog });
    await secondRefresh;
    const toastAfterNewerRefresh = useStore.getState().toast;

    olderRefresh.resolve({ catalog: oldCatalog });
    await firstRefresh;

    assert.equal(useStore.getState().catalog, newCatalog);
    assert.equal(useStore.getState().catalogLoading, false);
    assert.equal(useStore.getState().toast, toastAfterNewerRefresh);
  } finally {
    api.fields = originalFields;
  }
});
