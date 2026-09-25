import { create } from 'zustand';
import type {
  AuthorResponse,
  BuilderDraft,
  CatalogField,
  DatasourceCatalog,
  MetricSelection,
  Op,
  SlicerSelection,
} from '@pulse-metric-studio/shared';
import { resolveCatalogField } from '@pulse-metric-studio/shared';
import {
  api,
  ApiError,
  type CreateRunResponse,
  type RunReceipt,
  type ExistingMetricsResponse,
  type FollowState,
  type TableauSessionInfo,
} from './api/client';
import { buildCreatePayloads, defaultMetricSelection, defaultSlicerSelection, validateSelection, type ValidationError } from './features/pulse/lib/payloads';
import { mergeFollowStates, unavailableFollowState } from './features/pulse/follow-state';
import { applyDigestAudienceUpdate } from './features/pulse/digest-audience';
import { metricEligibilityIssue, reconcileCatalogMetrics, reconcileMetricWithCatalog } from './features/pulse/metric-eligibility';
import { applyMetricOperation, enforceMetricConstraints } from './features/pulse/metric-operations';
import { createDraftSaveQueue, type DraftSaveState } from './features/pulse/draft-save-queue';
import { notifyLlmHealth } from './llm-health-events';

export interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

export interface DsInfo {
  luid: string;
  name: string;
  projectName: string;
}

interface StoreState {
  // connection
  connected: boolean;
  session: TableauSessionInfo | null;
  connecting: boolean;
  connectError: string | null;
  statusChecked: boolean;

  // datasources
  datasources: DsInfo[];
  dsLoading: boolean;
  selectedDs: DsInfo | null;
  catalog: DatasourceCatalog | null;
  catalogLoading: boolean;
  catalogLoadError: string | null;

  // selection
  metrics: Record<string, MetricSelection>;
  slicers: Record<string, SlicerSelection>;
  digestAudience: string;
  digestAudienceLocked: boolean;
  groupFollow: boolean;
  hideUnused: boolean;

  // chat
  chat: ChatMsg[];
  chatBusy: boolean;
  hasGeneratedDraft: boolean;

  // publish
  publishing: boolean;
  ceremonyStep: string;
  lastRun: CreateRunResponse | null;
  runHistory: RunReceipt[];
  runHistoryLoading: boolean;
  runHistoryError: string | null;
  undoBusy: boolean;
  loadRunHistory: () => Promise<void>;
  openRun: (runId: string) => Promise<void>;

  // manager
  existing: ExistingMetricsResponse | null;
  existingLoading: boolean;
  followState: FollowState | null;

  // ui
  toast: { tone: 'success' | 'error' | 'info' | 'warning'; message: string; id: number } | null;

  // actions
  init: () => Promise<void>;
  disconnect: () => Promise<void>;
  loadDatasources: () => Promise<void>;
  selectDatasource: (luid: string) => Promise<void>;
  refreshFields: () => Promise<void>;
  toggleSlicer: (fieldId: string) => void;
  toggleMetric: (fieldId: string) => void;
  updateMetric: (fieldId: string, patch: Partial<MetricSelection>) => void;
  clearAll: () => void;
  sendChat: (text: string, opts?: { isDraft?: boolean }) => Promise<void>;
  applyOps: (ops: Op[], assistantMessage: string) => void;
  publish: () => Promise<void>;
  undoRun: () => Promise<void>;
  loadExisting: () => Promise<void>;
  showToast: (tone: 'success' | 'error' | 'info' | 'warning', message: string) => void;
  saveDraftDebounced: () => void;
  draftSaves: Record<string, DraftSaveState>;
  retryDraftSaves: () => Promise<void>;
}

let chatSeq = 1;
let toastSeq = 1;
let editorGeneration = 0;
let authorGeneration = 0;
let receiptRequestSeq = 0;
let datasourceListSeq = 0;
let existingRequestSeq = 0;
let datasourceSelectionSeq = 0;
let fieldRequestSeq = 0;

export const useStore = create<StoreState>((set, get) => ({
  connected: false,
  session: null,
  connecting: false,
  connectError: null,
  statusChecked: false,

  datasources: [],
  dsLoading: false,
  selectedDs: null,
  catalog: null,
  catalogLoading: false,
  catalogLoadError: null,

  metrics: {},
  slicers: {},
  digestAudience: '',
  digestAudienceLocked: false,
  groupFollow: true,
  hideUnused: false,

  chat: [],
  chatBusy: false,
  hasGeneratedDraft: false,

  publishing: false,
  ceremonyStep: '',
  lastRun: null,
  runHistory: [],
  runHistoryLoading: false,
  runHistoryError: null,
  undoBusy: false,

  existing: null,
  existingLoading: false,
  followState: null,

  toast: null,
  draftSaves: {},
  retryDraftSaves: async () => draftSaveQueue.retry(),

  async init() {
    try {
      const status = await api.status();
      if (status.connected && status.session) {
        set({ connected: true, session: status.session, statusChecked: true });
        await get().loadDatasources();
      } else {
        set({ connected: false, statusChecked: true });
      }
    } catch {
      set({ connected: false, statusChecked: true });
    }
  },

  async disconnect() {
    editorGeneration += 1;
    authorGeneration += 1;
    datasourceSelectionSeq += 1;
    fieldRequestSeq += 1;
    existingRequestSeq += 1;
    set({ chatBusy: false });
    await draftSaveQueue.retry();
    try {
      await api.disconnect();
      set({
        connected: false,
        session: null,
        datasources: [],
        selectedDs: null,
        catalog: null,
        metrics: {},
        slicers: {},
        chat: [],
        existing: null,
        followState: null,
      });
      get().showToast('info', 'Disconnected from Tableau');
    } catch (e) {
      get().showToast('error', e instanceof Error ? e.message : String(e));
    }
  },

  async loadDatasources() {
    const requestId = ++datasourceListSeq;
    const connection = connectionKey(get());
    const isCurrent = () => requestId === datasourceListSeq && connectionKey(get()) === connection;
    set({ dsLoading: true });
    try {
      const resp = await api.datasources();
      if (isCurrent()) set({ datasources: resp.datasources });
    } catch (e) {
      if (!isCurrent()) return;
      get().showToast('error', `Failed to load datasources: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (isCurrent()) set({ dsLoading: false });
    }
  },

  async selectDatasource(luid) {
    const ds = get().datasources.find((d) => d.luid === luid);
    if (!ds) return;
    editorGeneration += 1;
    authorGeneration += 1;
    const selectionRequestId = ++datasourceSelectionSeq;
    const fieldRequestId = ++fieldRequestSeq;
    const isCurrentRequest = () => (
      selectionRequestId === datasourceSelectionSeq &&
      fieldRequestId === fieldRequestSeq &&
      get().selectedDs?.luid === luid
    );
    existingRequestSeq += 1;
    set({
      selectedDs: ds,
      catalog: null,
      catalogLoading: true,
      catalogLoadError: null,
      metrics: {},
      slicers: {},
      chat: [],
      hasGeneratedDraft: false,
      chatBusy: false,
      publishing: false,
      ceremonyStep: '',
      digestAudience: '',
      groupFollow: true,
      digestAudienceLocked: false,
      existing: null,
      existingLoading: false,
      followState: null,
      lastRun: null,
      runHistory: [],
      runHistoryError: null,
      runHistoryLoading: false,
      undoBusy: false,
    });
    void get().loadRunHistory();
    try {
      const resp = await api.fields(luid);
      if (!isCurrentRequest()) return;
      const catalog = resp.catalog;

      let metrics: Record<string, MetricSelection> = {};

      // Restore saved draft if present
      let restored = false;
      try {
        const key = draftKey(get());
        await draftSaveQueue.flush(key);
        if (!isCurrentRequest()) return;
        const pendingDraft = draftSaveQueue.pending(key);
        const session = get().session;
        const context = session ? { connectionId: session.connectionId, serverUrl: session.serverUrl, siteId: session.siteId } : undefined;
        const draftResp = pendingDraft ? { draft: pendingDraft } : await api.loadDraft(luid, context);
        if (!isCurrentRequest()) return;
        const draft = draftResp.draft as BuilderDraft;
        if (draft && draft.version === 1) {
          restored = true;
          metrics = Object.fromEntries(
            Object.entries(draft.metrics ?? {}).map(([k, v]) => {
              const metric = v as MetricSelection;
              const requiresUserAgg = catalog.measures.find((field) => field.id === k)?.requiresUserAgg
                ?? metric.requiresUserAgg;
              return [k, { ...metric, requiresUserAgg, ...(requiresUserAgg ? { cumulative: false } : {}) }];
            }),
          );
          set({
            metrics: reconcileCatalogMetrics(catalog, metrics),
            slicers: Object.fromEntries(Object.entries(draft.slicers ?? {}).map(([k, v]) => [k, v as SlicerSelection])),
            digestAudience: draft.digestAudience ?? '',
            digestAudienceLocked: Boolean(draft.digestAudienceLocked),
            groupFollow: draft.groupFollow !== false,
            chat: (draft.chat ?? []).map((c) => ({ id: chatSeq++, role: c.role, content: c.content })),
            hasGeneratedDraft: (draft.chat ?? []).length > 0,
          });
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) {
          throw new Error(`Draft could not be restored: ${error instanceof Error ? error.message : error}`);
        }
      }

      if (!isCurrentRequest()) return;
      set({
        catalog,
        catalogLoading: false,
        ...(restored ? {} : { metrics: {}, slicers: {}, chat: [], hasGeneratedDraft: false }),
      });

      get().showToast('success', `Loaded ${catalog.measures.length + catalog.dimensions.length} fields${catalog.excluded.length ? ` (${catalog.excluded.length} excluded)` : ''}`);
      void get().loadExisting();
    } catch (e) {
      if (!isCurrentRequest()) return;
      set({ catalogLoading: false, catalogLoadError: e instanceof Error ? e.message : String(e) });
      get().showToast('error', `Failed to load fields: ${e instanceof Error ? e.message : e}`);
    }
  },

  async refreshFields() {
    const luid = get().selectedDs?.luid;
    if (!luid) return;
    const selectionRequestId = datasourceSelectionSeq;
    const fieldRequestId = ++fieldRequestSeq;
    const isCurrentRequest = () => (
      selectionRequestId === datasourceSelectionSeq &&
      fieldRequestId === fieldRequestSeq &&
      get().selectedDs?.luid === luid
    );
    set({ catalogLoading: true });
    try {
      const resp = await api.fields(luid, true);
      if (!isCurrentRequest()) return;
      set({ catalog: resp.catalog, metrics: reconcileCatalogMetrics(resp.catalog, get().metrics), catalogLoading: false });
      get().saveDraftDebounced();
      get().showToast('success', 'Field catalog refreshed');
    } catch (e) {
      if (!isCurrentRequest()) return;
      set({ catalogLoading: false });
      get().showToast('error', `Refresh failed: ${e instanceof Error ? e.message : e}`);
    }
  },

  toggleSlicer(fieldId) {
    const state = get();
    if (state.slicers[fieldId]) {
      const next = { ...state.slicers };
      delete next[fieldId];
      set({ slicers: next });
    } else {
      const field = findDimension(state.catalog, fieldId);
      if (!field) return;
      set({ slicers: { ...state.slicers, [fieldId]: defaultSlicerSelection(fieldId, field.label) } });
    }
    get().saveDraftDebounced();
  },

  toggleMetric(fieldId) {
    const state = get();
    if (state.metrics[fieldId]) {
      const current = state.metrics[fieldId];
      set({ metrics: { ...state.metrics, [fieldId]: { ...current, active: !current.active } } });
    } else {
      if (!state.catalog) return;
      const sel = defaultMetricSelection(state.catalog, fieldId);
      if (!sel) return;
      set({ metrics: { ...state.metrics, [fieldId]: sel } });
    }
    get().saveDraftDebounced();
  },

  updateMetric(fieldId, patch) {
    const state = get();
    const current = state.metrics[fieldId];
    if (!current) return;
    const locks = new Set(current.locks);
    for (const key of Object.keys(patch)) locks.add(key);

    // Cumulative rule: only SUM aggregates may run as running totals, and never percent format
    const merged = enforceMetricConstraints({ ...current, ...patch });
    if (merged.requiresUserAgg || state.catalog?.measures.find((field) => field.id === fieldId)?.requiresUserAgg
      || merged.aggregation !== 'SUM' || merged.format === 'PERCENT') {
      merged.cumulative = false;
    }
    set({ metrics: { ...state.metrics, [fieldId]: { ...merged, locks: [...locks] } } });
    get().saveDraftDebounced();
  },

  clearAll() {
    authorGeneration += 1;
    set({ chatBusy: false, metrics: {}, slicers: {}, chat: [], hasGeneratedDraft: false });
    get().saveDraftDebounced();
  },

  async sendChat(text, opts) {
    const state = get();
    if (!state.catalog || state.chatBusy) return;
    const generation = authorGeneration;
    const isCurrent = () => generation === authorGeneration && get().selectedDs?.luid === state.selectedDs?.luid && connectionKey(get()) === connectionKey(state);
    const userMsg: ChatMsg = { id: chatSeq++, role: 'user', content: text };
    const history = [...state.chat, userMsg];
    set({ chat: history, chatBusy: true });
    if (!opts?.isDraft) set({ hasGeneratedDraft: true });

    const selection = buildSelectionForLlm(state.metrics, state.slicers, state.digestAudience, state.digestAudienceLocked);
    try {
      const resp: AuthorResponse = await api.author({
        catalog: state.catalog,
        chat: history.slice(-12).map(({ role, content }) => ({ role, content })),
        userMessage: text,
        selection,
      });
      if (!isCurrent()) return;
      get().applyOps(resp.ops, resp.assistantMessage);
      const assistantMsg: ChatMsg = {
        id: chatSeq++,
        role: 'assistant',
        content: resp.assistantMessage || 'Updated the configuration.',
      };
      set((s) => ({ chat: [...s.chat, assistantMsg], chatBusy: false, hasGeneratedDraft: true }));
      notifyLlmHealth(true);
      if (resp.digestAudience) {
        const current = get();
        set({
          digestAudience: applyDigestAudienceUpdate(
            current.digestAudience,
            resp.digestAudience,
            current.digestAudienceLocked,
            'llm',
          ),
        });
      }
      get().saveDraftDebounced();
    } catch (e) {
      if (!isCurrent()) return;
      set({ chatBusy: false });
      notifyLlmHealth(false);
      get().showToast('error', `LLM request failed: ${e instanceof Error ? e.message : e}`);
    }
  },

  applyOps(ops, assistantMessage) {
    const state = get();
    if (!state.catalog) return;
    let metrics = { ...state.metrics };
    let slicers = { ...state.slicers };

    for (const op of ops) {
      switch (op.op) {
        case 'ADD_METRIC': {
          const field = resolveCatalogField(state.catalog, op.fieldId);
          if (!field) continue;
          const base =
            metrics[op.fieldId] ??
            ({
              active: true,
              fieldId: op.fieldId,
              fieldLabel: field.label,
              requiresUserAgg: field.requiresUserAgg,
              aggregation: 'SUM',
              cumulative: false,
              format: 'NUMBER',
              sentiment: 'NONE',
              name: field.label,
              description: '',
              timeDimensionFieldId: null,
              minGranularity: '',
              temporality: 'OVER_TIME',
              locks: [],
            } satisfies MetricSelection);
          const next = reconcileMetricWithCatalog(state.catalog, applyMetricOperation(base, op));
          const issue = metricEligibilityIssue(state.catalog, next);
          if (issue) { get().showToast('warning', issue); break; }
          metrics[op.fieldId] = next;
          break;
        }
        case 'MODIFY_METRIC': {
          const base = metrics[op.fieldId];
          if (!base) continue;
          const next = reconcileMetricWithCatalog(state.catalog, applyMetricOperation(base, op));
          const issue = metricEligibilityIssue(state.catalog, next);
          if (issue) { get().showToast('warning', issue); break; }
          metrics[op.fieldId] = next;
          break;
        }
        case 'REMOVE_METRIC': {
          const base = metrics[op.fieldId];
          if (base?.active) metrics[op.fieldId] = { ...base, active: false };
          break;
        }
        case 'ADD_SLICER': {
          if (!slicers[op.fieldId]) {
            const dim = findDimension(state.catalog, op.fieldId);
            if (dim) slicers[op.fieldId] = defaultSlicerSelection(op.fieldId, dim.label);
          } else {
            slicers[op.fieldId] = { ...slicers[op.fieldId], active: true };
          }
          break;
        }
        case 'REMOVE_SLICER': {
          if (slicers[op.fieldId]) {
            slicers[op.fieldId] = { ...slicers[op.fieldId], active: false };
          }
          break;
        }
        case 'SET_DIGEST_AUDIENCE':
          set({
            digestAudience: applyDigestAudienceUpdate(
              state.digestAudience,
              op.value,
              state.digestAudienceLocked,
              'llm',
            ),
          });
          break;
      }
    }

    // Cumulative rule enforcement
    for (const m of Object.values(metrics)) {
      if (m.requiresUserAgg || state.catalog.measures.find((field) => field.id === m.fieldId)?.requiresUserAgg
        || m.aggregation !== 'SUM' || m.format === 'PERCENT' || m.temporality === 'LATEST') metrics[m.fieldId] = { ...m, cumulative: false };
    }

    set({ metrics, slicers });
    void assistantMessage;
  },

  async publish() {
    const state = get();
    if (!state.selectedDs || !state.catalog || state.publishing) return;

    const generation = editorGeneration;
    const isCurrent = () => generation === editorGeneration;
    const input = { metrics: state.metrics, slicers: state.slicers, catalog: state.catalog };
    const errors: ValidationError[] = validateSelection(input);
    if (errors.length > 0) {
      get().showToast('warning', errors[0].message);
      return;
    }
    const payloads = buildCreatePayloads(input);

    const steps = ['Validating payloads', 'Publishing metrics to Pulse', 'Setting up digest group', 'Subscribing followers'];
    receiptRequestSeq += 1;
    set({ publishing: true, ceremonyStep: steps[0], lastRun: null });

    try {
      set({ ceremonyStep: steps[1] });
      const resp = await api.createMetrics({
        payloads,
        withGroupFollow: state.groupFollow,
        digestAudience: state.digestAudience || undefined,
        datasourceLuid: state.selectedDs.luid,
        datasourceName: state.selectedDs.name,
      });
      if (!isCurrent()) return;
      set({ lastRun: resp, ceremonyStep: '', publishing: false });
      if (resp.failedCount === 0) get().showToast('success', `Published ${resp.createdCount} metric(s)`);
      else get().showToast('warning', `${resp.createdCount} created, ${resp.failedCount} failed`);
      void get().loadExisting();
      void get().loadRunHistory();
    } catch (e) {
      if (!isCurrent()) return;
      set({ publishing: false, ceremonyStep: '' });
      get().showToast('error', `Publish failed: ${e instanceof Error ? e.message : e}`);
    }
  },

  async loadRunHistory() {
    const state = get();
    const luid = state.selectedDs?.luid;
    if (!luid) return;
    const generation = editorGeneration;
    set({ runHistoryLoading: true, runHistoryError: null });
    try {
      const response = await api.runs(luid);
      if (generation !== editorGeneration) return;
      set({ runHistory: response.runs, runHistoryLoading: false });
    } catch (error) {
      if (generation !== editorGeneration) return;
      set({ runHistoryLoading: false, runHistoryError: error instanceof Error ? error.message : String(error) });
    }
  },

  async openRun(runId) {
    if (get().undoBusy) return;
    const requestId = ++receiptRequestSeq;
    const generation = editorGeneration;
    try {
      const run = await api.run(runId);
      if (requestId !== receiptRequestSeq || generation !== editorGeneration) return;
      set({ lastRun: run });
    } catch (error) {
      if (generation !== editorGeneration) return;
      if (requestId !== receiptRequestSeq) return;
      get().showToast('error', `Could not open publish receipt: ${error instanceof Error ? error.message : error}`);
    }
  },

  async undoRun() {
    const state = get();
    const run = state.lastRun;
    if (!run || state.undoBusy || run.publishing) return;
    const generation = editorGeneration;
    receiptRequestSeq += 1;
    set({ undoBusy: true });
    try {
      const response = await api.undoRun(run.runId);
      if (generation !== editorGeneration) return;
      set({ lastRun: response.run, undoBusy: false });
      const unresolved = response.run.results.filter((item) => item.status === 'created' && item.definitionId && item.undoStatus !== 'deleted');
      if (response.failures.length || unresolved.length) {
        get().showToast('warning', `Undo incomplete: ${unresolved.length} ${unresolved.length === 1 ? 'resource needs' : 'resources need'} retry. ${response.failures.join('; ')}`);
      } else {
        get().showToast('success', `Undo complete: ${response.definitionsDeleted} definitions deleted`);
      }
      void get().loadExisting();
      void get().loadRunHistory();
    } catch (error) {
      if (generation !== editorGeneration) return;
      set({ undoBusy: false });
      get().showToast('error', `Undo failed: ${error instanceof Error ? error.message : error}`);
    }
  },

  async loadExisting() {
    const luid = get().selectedDs?.luid;
    if (!luid) return;
    const requestId = ++existingRequestSeq;
    const isCurrentRequest = () => (
      requestId === existingRequestSeq && get().selectedDs?.luid === luid
    );
    set({ existingLoading: true });
    try {
      const resp = await api.existingMetrics(luid);
      if (!isCurrentRequest()) return;
      set({ existing: resp, existingLoading: false });
      const metricIds = resp.definitions.flatMap((d) => d.metrics.map((m) => m.metricId));
      if (metricIds.length > 0) {
        try {
          const batches: string[][] = [];
          for (let index = 0; index < metricIds.length; index += 200) {
            batches.push(metricIds.slice(index, index + 200));
          }
          const settled = await Promise.allSettled(batches.map((batch) => api.followState(batch)));
          if (!isCurrentRequest()) return;
          const states = settled.map((result, index) => result.status === 'fulfilled'
            ? result.value
            : unavailableFollowState(
                batches[index],
                result.reason instanceof Error ? result.reason.message : String(result.reason),
              ));
          set({ followState: mergeFollowStates(states) });
          const failedBatchCount = settled.filter((result) => result.status === 'rejected').length;
          if (failedBatchCount > 0) {
            get().showToast('warning', `Follow state is partial because ${failedBatchCount} batch request${failedBatchCount === 1 ? '' : 's'} failed.`);
          }
        } catch (error) {
          if (!isCurrentRequest()) return;
          set({ followState: null });
          get().showToast('warning', `Follow state is unavailable: ${error instanceof Error ? error.message : error}`);
        }
      } else {
        set({ followState: null });
      }
    } catch (e) {
      if (!isCurrentRequest()) return;
      set({ existingLoading: false });
      get().showToast('error', `Existing metrics failed: ${e instanceof Error ? e.message : e}`);
    }
  },

  showToast(tone, message) {
    set({ toast: { tone, message, id: toastSeq++ } });
  },

  saveDraftDebounced() {
    const state = get();
    if (!state.selectedDs || !state.catalog) return;
    const draft: BuilderDraft = structuredClone({
      version: 1,
      datasourceLuid: state.selectedDs.luid,
      datasourceName: state.selectedDs.name,
      digestAudience: state.digestAudience,
      digestAudienceLocked: state.digestAudienceLocked,
      groupFollow: state.groupFollow,
      metrics: state.metrics,
      slicers: state.slicers,
      chat: state.chat.map(({ role, content }) => ({ role, content, ts: Date.now() })),
      updatedAt: Date.now(),
    });
    const context = state.session ? { connectionId: state.session.connectionId, serverUrl: state.session.serverUrl, siteId: state.session.siteId } : undefined;
    draftSaveQueue.schedule({ key: draftKey(state), draft, context });
  },
}));

function connectionKey(state: Pick<StoreState, 'session' | 'connected'>): string {
  const session = state.session;
  return JSON.stringify([state.connected, session?.connectionId, session?.serverUrl, session?.siteId, session?.userId]);
}
function draftKey(state: StoreState): string {
  return JSON.stringify([state.session?.connectionId, state.session?.serverUrl, state.session?.siteId, state.selectedDs?.luid]);
}
const draftSaveQueue = createDraftSaveQueue(
  ({ draft, context }) => api.saveDraft(draft.datasourceLuid, draft, context),
  (save) => useStore.setState((state) => ({ draftSaves: { ...state.draftSaves, [save.key]: save } })),
);
useStore.subscribe((state, previous) => {
  const connectionChanged = connectionKey(state) !== connectionKey(previous);
  if (connectionChanged || state.selectedDs?.luid !== previous.selectedDs?.luid) {
    editorGeneration += 1;
    authorGeneration += 1;
    if (state.chatBusy) useStore.setState({ chatBusy: false });
  }
  if (connectionChanged) {
    datasourceSelectionSeq += 1;
    fieldRequestSeq += 1;
    existingRequestSeq += 1;
    datasourceListSeq += 1;
    if (previous.session) useStore.setState({
      datasources: [], dsLoading: false,
      selectedDs: null, catalog: null, catalogLoading: false, catalogLoadError: null,
      metrics: {}, slicers: {}, chat: [], hasGeneratedDraft: false,
      digestAudience: '', digestAudienceLocked: false,
      lastRun: null, runHistory: [], runHistoryError: null, runHistoryLoading: false,
      undoBusy: false, existing: null, followState: null, publishing: false,
    });
  }
});

function findDimension(catalog: DatasourceCatalog | null, id: string): CatalogField | undefined {
  if (!catalog) return undefined;
  return (
    catalog.dimensions.find((f) => f.id === id) ??
    catalog.timeDimensions.find((f) => f.id === id) ??
    catalog.measures.find((f) => f.id === id)
  );
}

function buildSelectionForLlm(
  metrics: Record<string, MetricSelection>,
  slicers: Record<string, SlicerSelection>,
  digestAudience: string,
  locked: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of Object.values(metrics)) {
    if (!m.active && m.locks.length === 0) continue;
    out[m.fieldId] = {
      name: m.name,
      metric: {
        active: m.active,
        aggregation: m.aggregation,
        cumulative: m.cumulative,
        format: m.format,
        sentiment: m.sentiment,
        description: m.description,
        timeDimensionFieldId: m.timeDimensionFieldId,
        minGranularity: m.minGranularity || null,
      },
      locks: m.locks,
    };
  }
  for (const s of Object.values(slicers)) {
    out[s.fieldId] = out[s.fieldId] ?? {};
    (out[s.fieldId] as any).slicer = { active: s.active };
  }
  if (digestAudience) {
    out.__digestAudience__ = { value: digestAudience, locked };
  }
  return out;
}
