import { create } from "zustand";
import type {
  PulseDeletePlan,
  PulseDraftContext,
  PulseFollowersDetail,
  PulseFollowOperation,
  PulseInventoryResponse,
  PulseInventoryPatch,
  TableauThrottleMetadata,
  PulseVariantRequestV1,
} from "@pulse-metric-studio/shared";
import { registryApi, type RegistryApi } from "../api/registry";
import { pulseApi, PulseApiError, type PulseApi } from "../api/client";
import {
  forkRegistryActionItem,
  type RegistryActionResults,
} from "../registry-actions";
import { mergeFollowStates, replaceFollowDetails, replaceFollowMetrics, selectFollowMetrics, unavailableFollowState } from "../follow-state";
import { applyInventoryPatch } from "./inventory-patch";
import type { FollowState } from "./view-types";
import {
  reconcileFollowTargetResults,
  type FollowTargetChoice,
  targetLabelKey,
} from "../follow-target-actions";
import { errorMessage } from "../shell/notifications";
import { sessionOwnerKey, type SessionOwner } from "../shell/session-events";

interface RegistryState {
  context: PulseDraftContext | null;
  owner: SessionOwner | null;
  mutationAvailable: boolean;
  setMutationAvailable(available: boolean): void;
  datasourceName: string;
  inventory: PulseInventoryResponse | null;
  followState: FollowState | null;
  loading: boolean;
  pendingProviderOperations: number;
  trackProviderOperation<T>(operation: () => Promise<T>, owner?: SessionOwner | null): Promise<T>;
  followLoading: boolean;
  error: string | null;
  busy: "fork" | "delete" | "follow" | "unfollow" | null;
  results: RegistryActionResults | null;
  outcomes: Record<string, RegistryActionResults>;
  createdMetricIds: string[];
  cooldown: { retryAt: number; remainingSeconds: number } | null;
  pollCooldown(): Promise<void>;
  deletePlan: PulseDeletePlan | null;
  deleteLoading: boolean;
  deleteError: string | null;
  /** The last review stopped because Tableau did not return complete inventory. */
  deleteOverridable: boolean;
  setContext: (
    context: PulseDraftContext | null,
    datasourceName?: string,
    owner?: SessionOwner | null,
  ) => void;
  activateContext: (context: PulseDraftContext | null, datasourceName?: string, owner?: SessionOwner | null) => Promise<void>;
  load: (options?: { refresh?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
  ensureLoaded: () => Promise<void>;
  invalidate: (context?: PulseDraftContext | null, owner?: SessionOwner | null) => Promise<void>;
  fork: (
    request: PulseVariantRequestV1,
    labels: Map<string, string>,
  ) => Promise<void>;
  previewDelete: (
    metricIds: string[],
    definitionIds: string[],
    allowIncompleteInventory?: boolean,
  ) => Promise<void>;
  /** Reviews deletion of known definitions whose cached child inventory is incomplete. */
  reviewDeleteAnyway: () => Promise<void>;
  cancelDelete: () => void;
  executeDelete: () => Promise<void>;
  dismissResults: () => void;
  follow: (
    kind: "follow" | "unfollow",
    operations: PulseFollowOperation[],
    metrics: Array<{ id: string; label: string }>,
    targets: FollowTargetChoice[],
  ) => Promise<PulseFollowOperation[]>;
  loadTargets: (refresh?: boolean) => ReturnType<RegistryApi["followTargets"]>;
  invalidateTargets: (owner?: SessionOwner | null) => void;
  ensureFollowState: (metricIds: string[]) => Promise<void>;
  loadMoreFollowState: (metricIds: string[]) => Promise<void>;
  /** Reads a fresh, selection-scoped identity snapshot without replacing inventory state. */
  refreshFollowState: (metricIds: string[]) => Promise<FollowState | null>;
  loadFollowers: (
    metricIds: string[],
  ) => Promise<{ details: PulseFollowersDetail[] }>;
}
function key(context: PulseDraftContext | null, owner: SessionOwner | null = null): string {
  return context ? JSON.stringify([context.connectionId, context.serverUrl, context.siteId, context.datasourceLuid, sessionOwnerKey(owner)]) : "null";
}
export { key as registryScopeKey };

export function createRegistryController(
  transport: RegistryApi = registryApi,
  deletion: Pick<PulseApi, "previewDelete" | "delete"> = pulseApi,
) {
  const idsFor = (inventory: PulseInventoryResponse) => inventory.definitions.flatMap(definition => definition.metrics.map(metric => metric.metricId));
  type MetricEvidence = { version: number; state: FollowState };
  type DetailScope = { versions: Map<string, number>; countVersions: Map<string, number>; evidence: Map<string, MetricEvidence>; pending: Map<string, Promise<MetricEvidence | null>> };
  type InventoryIdentity = { detailScope: DetailScope };
  type InventoryRead = { identity: InventoryIdentity; promise: Promise<CachedInventory>; inventory?: PulseInventoryResponse; details: Map<string, MetricEvidence>; detailScope: DetailScope; countVersions: Map<string, number> };
  type CachedInventory = { inventory: PulseInventoryResponse; followState: FollowState | null; loadedAt: number; operation: InventoryIdentity };
  const cache = new Map<string, CachedInventory>();
  const pending = new Map<string, InventoryRead>();
  const providerOperations = new Map<string, number>();
  const trailingStatus = new Map<string, ReturnType<typeof setTimeout>>();
  const detailScopes = new Map<string, DetailScope>();
  let activeDetailRequests = 0;
  const waitingDetailRequests: Array<() => void> = [];
  const detailRequest = <T,>(read: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const start = () => {
      activeDetailRequests++;
      void read().then(resolve, reject).finally(() => {
        activeDetailRequests--;
        waitingDetailRequests.shift()?.();
      });
    };
    if (activeDetailRequests < 4) start();
    else waitingDetailRequests.push(start);
  });
  const directories = new Map<string, { value: Awaited<ReturnType<RegistryApi["followTargets"]>>; loadedAt: number }>();
  const directoryPending = new Map<string, ReturnType<RegistryApi["followTargets"]>>();
  const retain = (cacheKey: string, value: CachedInventory) => {
    cache.delete(cacheKey);
    cache.set(cacheKey, value);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
  };
  const cooldownReads = new Map<string, number>();
  const cooldownVersions = new Map<string, number>();
  const cooldownPollRequests = new Map<string, number>();
  let generation = 0;
  let inventoryRequest = 0;
  let deleteRequest = 0;
  let deleteBatches: PulseDeletePlan[] = [];
  let deleteSelection: { metricIds: string[]; definitionIds: string[] } | null =
    null;
  const INCOMPLETE_INVENTORY_CODES = [
    "delete_inventory_incomplete",
  ];
  const overridable = (error: unknown) =>
    error instanceof PulseApiError &&
    INCOMPLETE_INVENTORY_CODES.includes(error.code ?? "");
  return create<RegistryState>((set, get) => {
    const activeKey = () => key(get().context, get().owner);
    const capture = () => ({ context: get().context, owner: get().owner, key: activeKey(), generation });
    const current = (scope: ReturnType<typeof capture>) =>
      scope.generation === generation &&
      scope.key === activeKey();
    const captureThrottle = (scope: ReturnType<typeof capture>, throttle: TableauThrottleMetadata | undefined) => {
      if (!throttle || sessionOwnerKey(scope.owner) !== sessionOwnerKey(get().owner)) return;
      const ownerKey = sessionOwnerKey(scope.owner);
      cooldownVersions.set(ownerKey, (cooldownVersions.get(ownerKey) ?? 0) + 1);
      const retryAt = Math.max(get().cooldown?.retryAt ?? 0, throttle.retryAt);
      set({ cooldown: { retryAt, remainingSeconds: Math.max(0, Math.ceil((retryAt - throttle.serverTime) / 1000)) } });
    };
    const captureCooldown = (scope: ReturnType<typeof capture>, error: unknown) => {
      if (error instanceof PulseApiError) captureThrottle(scope, error.throttle);
    };
    const record = (
      scope: ReturnType<typeof capture>,
      results: RegistryActionResults,
    ) =>
      set((state) => ({
        outcomes: { ...state.outcomes, [scope.key]: results },
        ...(current(scope) ? { results } : {}),
      }));
    const applyPatch = (scope: ReturnType<typeof capture>, patch: PulseInventoryPatch | undefined) => {
      if (!patch) return;
      const addMissingEvidence = (state: FollowState | null) => {
        if (!state) state = { userFollowsByMetricId: {}, groupFollowsByMetricId: {}, followerCountsByMetricId: {}, errors: [], availabilityByMetricId: {} };
        const availabilityByMetricId = { ...state.availabilityByMetricId };
        for (const metric of patch.inventory?.definitions.flatMap(definition => definition.metrics) ?? patch.upserts.map(upsert => upsert.metric)) if (!availabilityByMetricId[metric.metricId]) availabilityByMetricId[metric.metricId] = {
          status: "partial", relationshipStatus: "not_requested", followerIdsStatus: "not_requested", followerCountStatus: "not_requested", diagnostics: [],
        };
        return { ...state, availabilityByMetricId };
      };
      const saved = cache.get(scope.key);
      if (saved) {
        const inventory = applyInventoryPatch(saved.inventory, patch);
        if (inventory !== saved.inventory) retain(scope.key, { ...saved, inventory, followState: addMissingEvidence(saved.followState) });
      }
      const read = pending.get(scope.key);
      if (read?.inventory) read.inventory = applyInventoryPatch(read.inventory, patch);
      if (scope.key === activeKey() && get().inventory) {
        const inventory = applyInventoryPatch(get().inventory!, patch);
        if (inventory !== get().inventory) set({ inventory, followState: addMissingEvidence(get().followState) });
      }
    };
    const rebaseInventory = (scopeKey: string, inventory: PulseInventoryResponse) => {
      const retained = scopeKey === activeKey() ? get().inventory : cache.get(scopeKey)?.inventory;
      // A read establishes the owner lifetime. Revisions are comparable only inside it.
      return retained && retained.lifetimeId === inventory.lifetimeId &&
        (retained.revision ?? 0) > (inventory.revision ?? 0) ? retained : inventory;
    };
    const pruneDetailScopes = () => {
      for (const [scopeKey, reads] of detailScopes) {
        if (detailScopes.size <= 8) break;
        if (scopeKey !== activeKey() && !cache.has(scopeKey) && !pending.has(scopeKey) && !reads.pending.size) detailScopes.delete(scopeKey);
      }
    };
    const detailScopeFor = (scopeKey: string) => {
      let reads = detailScopes.get(scopeKey);
      if (!reads) {
        reads = { versions: new Map(), countVersions: new Map(), evidence: new Map(), pending: new Map() };
        detailScopes.set(scopeKey, reads);
      }
      pruneDetailScopes();
      return reads;
    };
    const evidenceCurrent = (scope: ReturnType<typeof capture>, reads: DetailScope, id: string, version: number) =>
      sessionOwnerKey(scope.owner) === sessionOwnerKey(get().owner) &&
      detailScopes.get(scope.key) === reads && (reads.versions.get(id) ?? 0) === version;
    const supersedeDetails = (scope: ReturnType<typeof capture>, ids: string[]) => {
      const reads = detailScopeFor(scope.key);
      for (const id of ids) {
        reads.versions.set(id, (reads.versions.get(id) ?? 0) + 1);
        reads.evidence.delete(id);
        reads.pending.delete(id);
      }
    };
    const withoutCounts = (state: FollowState | null, ids: string[]) => {
      if (!state || !ids.length) return state;
      const result = structuredClone(state);
      for (const id of ids) {
        delete result.followerCountsByMetricId[id];
        const availability = result.availabilityByMetricId?.[id];
        if (availability) {
          availability.followerCountStatus = "not_requested";
          if (availability.status === "available") availability.status = "partial";
        }
      }
      return result;
    };
    const fenceCounts = (reads: DetailScope, versions: Map<string, number>, state: FollowState | null) =>
      withoutCounts(state, [...versions].filter(([id, version]) => (reads.countVersions.get(id) ?? 0) !== version).map(([id]) => id));
    const invalidateCounts = (scope: ReturnType<typeof capture>, ids: string[]) => {
      const reads = detailScopeFor(scope.key);
      for (const id of ids) reads.countVersions.set(id, (reads.countVersions.get(id) ?? 0) + 1);
      const saved = cache.get(scope.key);
      if (saved) retain(scope.key, { ...saved, followState: withoutCounts(saved.followState, ids) });
      if (scope.key === activeKey()) set({ followState: withoutCounts(get().followState, ids) });
    };
    const overlayDetails = (scope: ReturnType<typeof capture>, operation: InventoryRead, base: FollowState | null) => {
      base = fenceCounts(operation.detailScope, operation.countVersions, base);
      const states: FollowState[] = [];
      const ids: string[] = [];
      for (const [id, evidence] of operation.details) {
        if (evidenceCurrent(scope, operation.detailScope, id, evidence.version)) {
          states.push(evidence.state);
          ids.push(id);
        }
      }
      return ids.length ? replaceFollowDetails(base, mergeFollowStates(states), ids) : base;
    };
    const readFollowState = async (scope: ReturnType<typeof capture>, metricIds: string[], refresh = false, continueCoverage = false) => {
      if (!scope.context || sessionOwnerKey(scope.owner) !== sessionOwnerKey(get().owner)) return null;
      const ids = [...new Set(metricIds)];
      const reads = detailScopeFor(scope.key);
      const missing = ids.filter(id => !reads.pending.has(id) && !reads.evidence.has(id));
      for (let offset = 0; offset < missing.length; offset += 200) {
        const batch = missing.slice(offset, offset + 200);
        const versions = new Map(batch.map(id => [id, reads.versions.get(id) ?? 0]));
        const request = detailRequest(async () => {
          const valid = batch.filter(id => evidenceCurrent(scope, reads, id, versions.get(id)!));
          if (!valid.length) return null;
          try {
            const previous = current(scope) ? get().followState : cache.get(scope.key)?.followState;
            const missingCounts = valid.filter(id => refresh || previous?.availabilityByMetricId?.[id]?.followerCountStatus === "not_requested");
            const [details, counts] = await Promise.all([
              get().trackProviderOperation(() => transport.followState(valid, true, scope.owner, { snapshotId: (current(scope) ? get().inventory : cache.get(scope.key)?.inventory)?.snapshotId, continueCoverage, refresh }), scope.owner).catch(error => {
                const unavailable = unavailableFollowState(valid, errorMessage(error));
                for (const [id, availability] of Object.entries(unavailable.availabilityByMetricId ?? {})) {
                  availability.followerCountStatus = "not_requested";
                  // A failed continuation supplies no replacement cursor evidence.
                  // Keep its explicit retry hint, while identities remain unavailable.
                  if (continueCoverage && previous?.availabilityByMetricId?.[id]?.canLoadMore === true)
                    availability.canLoadMore = true;
                }
                return unavailable;
              }),
              missingCounts.length ? get().trackProviderOperation(() => transport.followState(missingCounts, false, scope.owner), scope.owner).catch(error => unavailableFollowState(missingCounts, errorMessage(error))) : Promise.resolve(null),
            ]);
            return counts ? replaceFollowDetails(counts, details, valid) : details;
          }
          catch (error) { return unavailableFollowState(valid, errorMessage(error)); }
        });
        for (const id of batch) {
          const version = versions.get(id)!;
          const requestForMetric = request.then(result => {
            if (!result || !evidenceCurrent(scope, reads, id, version)) return null;
            const evidence = { version, state: selectFollowMetrics(result, [id]) };
            reads.evidence.set(id, evidence);
            return evidence;
          });
          reads.pending.set(id, requestForMetric);
          void requestForMetric.finally(() => {
            if (reads.pending.get(id) === requestForMetric) reads.pending.delete(id);
            pruneDetailScopes();
          }).catch(() => {});
        }
      }
      const requested = ids.map(id => reads.pending.get(id) ?? Promise.resolve(reads.evidence.get(id) ?? null));
      const resolved = await Promise.all(requested);
      const accepted: Array<{ id: string; evidence: MetricEvidence }> = [];
      for (const [index, evidence] of resolved.entries()) {
        const id = ids[index]!;
        if (evidence && evidenceCurrent(scope, reads, id, evidence.version)) accepted.push({ id, evidence });
      }
      if (!accepted.length) return null;
      const result = mergeFollowStates(accepted.map(({ evidence }) => evidence.state));
      const validIds = accepted.map(({ id }) => id);
      const operation = pending.get(scope.key);
      if (operation?.detailScope === reads)
        for (const { id, evidence } of accepted) operation.details.set(id, evidence);
      const saved = cache.get(scope.key);
      if (saved?.operation.detailScope === reads)
        retain(scope.key, { ...saved, followState: replaceFollowDetails(saved.followState, result, validIds) });
      // Every caller consumes its shared result with its own current navigation scope.
      if (current(scope)) set({ followState: replaceFollowDetails(get().followState, result, validIds) });
      return accepted.length === ids.length ? result : null;
    };
    return {
      context: null,
      owner: null,
      mutationAvailable: true,
      setMutationAvailable: (available) => {
        if (get().mutationAvailable !== available) set({ mutationAvailable: available });
      },
      datasourceName: "",
      inventory: null,
      followState: null,
      loading: false,
      pendingProviderOperations: 0,
      async trackProviderOperation(operation, owner = get().owner) {
        const scope = { ...capture(), owner };
        const ownerKey = sessionOwnerKey(owner);
        const publish = () => { if (ownerKey === sessionOwnerKey(get().owner)) set({ pendingProviderOperations: providerOperations.get(ownerKey) ?? 0 }); };
        providerOperations.set(ownerKey, (providerOperations.get(ownerKey) ?? 0) + 1);
        publish();
        try { return await operation(); }
        catch (error) { captureCooldown(scope, error); throw error; }
        finally {
          const remaining = (providerOperations.get(ownerKey) ?? 1) - 1;
          if (remaining) providerOperations.set(ownerKey, remaining); else providerOperations.delete(ownerKey);
          publish();
          const previous = trailingStatus.get(ownerKey);
          if (previous) clearTimeout(previous);
          trailingStatus.delete(ownerKey);
          // One final observation catches a fast operation that ended after an unthrottled poll.
          // It is tied to completed work and never starts an idle polling loop.
          if (ownerKey === sessionOwnerKey(get().owner) && transport.throttle) {
            const timer = setTimeout(() => {
              trailingStatus.delete(ownerKey);
              if (ownerKey === sessionOwnerKey(get().owner)) void get().pollCooldown();
            }, Math.max(0, 1000 - (Date.now() - (cooldownReads.get(ownerKey) ?? 0))));
            trailingStatus.set(ownerKey, timer);
            (timer as unknown as { unref?: () => void }).unref?.();
          }
        }
      },
      followLoading: false,
      error: null,
      busy: null,
      results: null,
      outcomes: {},
      cooldown: null,
      async pollCooldown() {
        const scope = capture();
        try {
          const ownerKey = sessionOwnerKey(scope.owner);
          const lastRead = cooldownReads.get(ownerKey);
          if (lastRead !== undefined && Date.now() - lastRead < 1000) return;
          cooldownReads.set(ownerKey, Date.now());
          if (!transport.throttle) return;
          const version = cooldownVersions.get(ownerKey) ?? 0;
          const request = (cooldownPollRequests.get(ownerKey) ?? 0) + 1;
          cooldownPollRequests.set(ownerKey, request);
          const status = await transport.throttle(scope.owner);
          if (ownerKey !== sessionOwnerKey(get().owner) || version !== (cooldownVersions.get(ownerKey) ?? 0) || request !== cooldownPollRequests.get(ownerKey)) return;
          const remainingSeconds = status.retryAt === null ? 0 : Math.max(0, Math.ceil((status.retryAt - status.serverTime) / 1000));
          set({ cooldown: status.throttled && status.retryAt !== null ? { retryAt: status.retryAt, remainingSeconds } : null });
        } catch { /* Status failure must not replace mutation receipts. */ }
      },
      createdMetricIds: [],
      deletePlan: null,
      deleteLoading: false,
      deleteError: null,
      deleteOverridable: false,
      setContext(context, datasourceName = "", owner = null) {
        if (key(context, owner) === activeKey()) {
          if (datasourceName !== get().datasourceName) set({ datasourceName });
          return;
        }
        generation += 1;
        inventoryRequest += 1;
        deleteRequest += 1;
        deleteBatches = [];
        deleteSelection = null;
        const saved = cache.get(key(context, owner));
        set({
          context,
          owner: owner ? { ...owner } : null,
          datasourceName,
          inventory: saved?.inventory ?? null,
          followState: saved?.followState ?? null,
          followLoading: false,
          loading: false,
          pendingProviderOperations: providerOperations.get(sessionOwnerKey(owner)) ?? 0,
          error: null,
          busy: null,
          results: get().outcomes[key(context, owner)] ?? null,
          cooldown: sessionOwnerKey(owner) === sessionOwnerKey(get().owner) ? get().cooldown : null,
          createdMetricIds: [],
          deletePlan: null,
          deleteLoading: false,
          deleteError: null,
          deleteOverridable: false,
        });
      },
      async activateContext(context, datasourceName, owner = null) {
        const changed = key(context, owner) !== activeKey();
        get().setContext(context, datasourceName, owner);
        if (context && changed) await get().ensureLoaded();
      },
      async ensureLoaded() {
        if (!get().context) return;
        const saved = cache.get(activeKey());
        if (!pending.has(activeKey()) && saved && Date.now() - saved.loadedAt < 60_000) return;
        await get().load();
      },
      async invalidate(context = get().context, owner = get().owner) {
        if (!context) return;
        const cacheKey = key(context, owner);
        cache.delete(cacheKey);
        pending.delete(cacheKey);
        detailScopes.delete(cacheKey);
        if (cacheKey === activeKey()) await get().load();
      },
      async refresh() {
        const scope = capture();
        if (!scope.context) return;
        cache.delete(scope.key);
        pending.delete(scope.key);
        detailScopes.delete(scope.key);
        await get().load({ refresh: true });
      },
      async load(options) {
        const scope = capture();
        if (!scope.context) return;
        const request = ++inventoryRequest;
        let operation = pending.get(scope.key);
        if (!operation) {
          if (pending.size >= 8) {
            set({ error: "Wait for pending inventory requests before refreshing another datasource." });
            return;
          }
          detailScopes.delete(scope.key);
          const detailScope = detailScopeFor(scope.key);
          operation = { identity: { detailScope }, promise: undefined!, details: new Map(), detailScope, countVersions: new Map() };
          const read = operation;
          read.promise = (async (): Promise<CachedInventory> => {
            const inventory = rebaseInventory(scope.key, await get().trackProviderOperation(() => transport.inventory(scope.context!, scope.owner, options), scope.owner));
            const result = (followState: FollowState | null): CachedInventory => {
              const rebased = rebaseInventory(scope.key, inventory);
              const knownIds = new Set(idsFor(inventory));
              const addedIds = idsFor(rebased).filter(id => !knownIds.has(id));
              const retained = current(scope) ? get().followState : cache.get(scope.key)?.followState;
              return { inventory: rebased, followState: retained && addedIds.length ? mergeFollowStates([...(followState ? [followState] : []), selectFollowMetrics(retained, addedIds)]) : followState, loadedAt: Date.now(), operation: read.identity };
            };
            if (sessionOwnerKey(scope.owner) !== sessionOwnerKey(get().owner)) return result(null);
            read.inventory = inventory;
            if (current(scope) && pending.get(scope.key) === read)
              set({ inventory, loading: false, followLoading: true });
            const ids = inventory.definitions.flatMap((definition) => definition.metrics.map((metric) => metric.metricId));
            const states: FollowState[] = [];
            for (let offset = 0; offset < ids.length; offset += 800) {
              if (sessionOwnerKey(scope.owner) !== sessionOwnerKey(get().owner)) return result(null);
              const batches = Array.from({ length: Math.ceil(Math.min(800, ids.length - offset) / 200) },
                (_, index) => ids.slice(offset + index * 200, offset + (index + 1) * 200));
              await Promise.all(batches.map(async (batch) => {
                for (const id of batch) read.countVersions.set(id, detailScope.countVersions.get(id) ?? 0);
                let state: FollowState;
                try { state = await get().trackProviderOperation(() => transport.followState(batch, false, scope.owner), scope.owner); }
                catch (error) {
                  state = unavailableFollowState(batch, errorMessage(error));
                  for (const availability of Object.values(state.availabilityByMetricId ?? {})) {
                    availability.relationshipStatus = "not_requested";
                    availability.followerIdsStatus = "not_requested";
                  }
                }
                states.push(state);
                if (current(scope) && pending.get(scope.key) === read)
                  set({ followState: overlayDetails(scope, read, mergeFollowStates([...(get().followState ? [get().followState!] : []), ...states])) });
              }));
            }
            const completed = result(overlayDetails(scope, read, ids.length ? mergeFollowStates(states) : null));
            if (pending.get(scope.key) === read) retain(scope.key, completed);
            return completed;
          })();
          pending.set(scope.key, read);
          void read.promise.finally(() => {
            if (pending.get(scope.key) === read) pending.delete(scope.key);
            pruneDetailScopes();
          }).catch(() => {});
        }
        const read = operation;
        set({ loading: !read.inventory, followLoading: Boolean(read.inventory), error: null,
          ...(read.inventory ? { inventory: read.inventory } : {}) });
        try {
          await read.promise;
          const latest = cache.get(scope.key);
          if (current(scope) && request === inventoryRequest && latest?.operation === read.identity)
            set({ inventory: latest.inventory, followState: latest.followState, loading: false, followLoading: false });
        } catch (error) {
          if (current(scope) && request === inventoryRequest) set({ error: errorMessage(error), loading: false, followLoading: false });
        }
      },
      async fork(request, labels) {
        const scope = capture();
        if (!scope.context || get().busy || !get().mutationAvailable || get().cooldown) return;
        set({ busy: "fork", error: null });
        try {
          const summary = await get().trackProviderOperation(() => transport.fork(scope.context!, request, scope.owner, { snapshotId: get().inventory?.snapshotId, sourceContextId: request.sourceContextId }), scope.owner);
          captureThrottle(scope, summary.throttle);
          applyPatch(scope, summary.inventoryPatch);
          if (current(scope))
            set((state) => ({
              createdMetricIds: [
                ...new Set([
                  ...state.createdMetricIds,
                  ...summary.results
                    .filter(
                      (result) =>
                        result.creationStatus === "created" && result.metricId,
                    )
                    .map((result) => result.metricId!),
                ]),
              ],
            }));
          record(scope, {
            kind: "fork",
            title: "Variant results",
            summary: summary.error,
            finishedAt: Date.now(),
            items: summary.results.map((result, index) =>
              forkRegistryActionItem(
                result,
                labels.get(result.sourceMetricId) ?? result.sourceMetricId,
                index,
              ),
            ),
          });
          if (current(scope)) {
            if (summary.terminated)
              set({
                error:
                  "Fork stopped because the Tableau session ended. Confirmed, unknown, and unsent outcomes are shown separately.",
              });

          }
        } catch (error) {
          captureCooldown(scope, error);
          record(scope, {
            kind: "fork",
            title: "Variant results",
            finishedAt: Date.now(),
            items: request.sourceMetricIds.map((metricId) => ({
              key: `fork:${metricId}`,
              metricId,
              metricLabel: labels.get(metricId) ?? metricId,
              status: error instanceof PulseApiError && error.status === 429 && error.throttle?.sent !== true ? "not_attempted" : "unknown",
              creationStatus: error instanceof PulseApiError && error.status === 429 && error.throttle?.sent !== true ? "not_attempted" : "unknown",
              detail: error instanceof PulseApiError && error.status === 429 && error.throttle?.sent !== true ? `The request was not sent. ${errorMessage(error)}` : `The request did not return a receipt. Inspect Tableau before retrying. ${errorMessage(error)}`,
            })),
          });
        } finally {
          if (current(scope)) set({ busy: null });
        }
      },
      async previewDelete(
        metricIds,
        definitionIds,
        allowIncompleteInventory = false,
      ) {
        const scope = capture();
        if (!scope.context || get().busy || !get().mutationAvailable || get().cooldown) return;
        const request = ++deleteRequest;
        deleteBatches = [];
        deleteSelection = { metricIds, definitionIds };
        set({
          deleteLoading: true,
          deletePlan: null,
          deleteError: null,
          deleteOverridable: false,
        });
        try {
          const inventory = get().inventory;
          if (!inventory?.snapshotId)
            throw new Error("Refresh metrics before reviewing a deletion.");
          const followState = get().followState;
          const followerCounts = new Map(Object.entries(followState?.followerCountsByMetricId ?? {})
            .map(([id, count]) => [id, followState?.availabilityByMetricId?.[id]?.followerCountStatus === "unavailable" ? null : count] as const));
          const metricNames = new Map(inventory.definitions.flatMap((definition) =>
            definition.metrics.map((metric) => [metric.metricId, metric.name || definition.name] as const),
          ));
          const definitions = [...new Set(definitionIds)];
          const covered = new Set(
            inventory.definitions.filter((definition) =>
                definitions.includes(definition.definitionId),
              )
              .flatMap((definition) =>
                definition.metrics.map((metric) => metric.metricId),
              ),
          );
          const metrics = [...new Set(metricIds)].filter(
            (id) => !covered.has(id),
          );
          const plans: PulseDeletePlan[] = [];
          for (
            let offset = 0;
            offset < Math.max(metrics.length, definitions.length);
            offset += 1000
          ) {
            const plan = await deletion.previewDelete({
              context: scope.context,
              snapshotId: inventory.snapshotId,
              metricIds: metrics.slice(offset, offset + 1000),
              definitionIds: definitions.slice(offset, offset + 1000),
              allowIncompleteInventory,
            });
            if (!current(scope) || request !== deleteRequest) return;
            plans.push({
              ...plan,
              targets: plan.targets.map((target) => ({
                ...target,
                affectedMetrics: target.affectedMetricIds.map((id) => ({
                  id,
                  name: metricNames.get(id) ?? id,
                  followerCount: followerCounts.get(id) ?? null,
                })),
              })),
            });
          }
          if (!plans.length)
            throw new Error("Select at least one resource to delete.");
          deleteBatches = plans;
          set({
            deletePlan: {
              ...plans[0],
              metricIds: metrics,
              definitionIds: definitions,
              targets: plans.flatMap((plan) => plan.targets),
              warnings: [...new Set(plans.flatMap((plan) => plan.warnings))],
            },
          });
        } catch (error) {
          if (current(scope) && request === deleteRequest)
            set({
              deleteError: errorMessage(error),
              deleteOverridable: !allowIncompleteInventory && overridable(error),
            });
        } finally {
          if (current(scope) && request === deleteRequest)
            set({ deleteLoading: false });
        }
      },
      async reviewDeleteAnyway() {
        if (!deleteSelection) return;
        const { metricIds, definitionIds } = deleteSelection;
        await get().previewDelete(metricIds, definitionIds, true);
      },
      cancelDelete() {
        if (get().busy === "delete") return;
        deleteRequest += 1;
        deleteBatches = [];
        deleteSelection = null;
        set({
          deletePlan: null,
          deleteError: null,
          deleteLoading: false,
          deleteOverridable: false,
        });
      },
      async executeDelete() {
        const scope = capture();
        const plan = get().deletePlan;
        if (!scope.context || !plan || get().busy || !get().mutationAvailable || get().cooldown) return;
        set({ busy: "delete", deleteError: null });
        const batches = [...deleteBatches];
        const outcomes: Awaited<ReturnType<PulseApi["delete"]>>["outcomes"] =
          [];
        const sent = new Set<string>();
        let activeBatch: PulseDeletePlan | undefined;
        let failure: string | undefined;
        try {
          for (const batch of batches) {
            activeBatch = batch;
            if (!current(scope)) {
              failure =
                "The connection or datasource changed. Remaining deletions were not sent.";
              break;
            }
            batch.targets.forEach((target) =>
              sent.add(`${target.kind}:${target.id}`),
            );
            const response = await get().trackProviderOperation(() => deletion.delete({
              context: batch.context,
              snapshotId: batch.snapshotId,
              metricIds: batch.metricIds,
              definitionIds: batch.definitionIds,
              previewFingerprint: batch.previewFingerprint,
              allowIncompleteInventory: batch.allowIncompleteInventory,
            }), scope.owner);
            captureThrottle(scope, response.throttle);
            applyPatch(scope, response.inventoryPatch);
            outcomes.push(...response.outcomes);
            if (response.failures.length) {
              failure = response.failures.join(" ");
              break;
            }
          }
        } catch (error) {
          captureCooldown(scope, error);
          failure = errorMessage(error);
          if (
            error instanceof PulseApiError &&
            ([400, 401, 409, 422].includes(error.status) || (error.status === 429 && error.throttle?.sent !== true))
          ) {
            activeBatch?.targets.forEach((target) =>
              sent.delete(`${target.kind}:${target.id}`),
            );
            if (!outcomes.length && error.status !== 429) {
              deleteBatches = [];
              if (current(scope))
                set({
                  deleteError: failure,
                  deleteOverridable:
                    !plan.allowIncompleteInventory && overridable(error),
                  deletePlan: null,
                  busy: null,
                });
              return;
            }
          }
        }
        let resultsRecorded = false;
        try {
          const outcomesByTarget = new Map(
            outcomes.map((outcome) => [
              outcome.definitionId
                ? `definition:${outcome.definitionId}`
                : `metric:${outcome.metricId}`,
              outcome,
            ]),
          );
          const items = plan.targets.map((target) => {
            const outcome = outcomesByTarget.get(`${target.kind}:${target.id}`);
            return {
              key: `${target.kind}:${target.id}`,
              metricId: target.id,
              metricLabel: target.name,
              status:
                outcome &&
                ["deleted", "already_absent"].includes(outcome.status)
                  ? ("removed" as const)
                  : outcome
                    ? outcome.status === "unknown"
                      ? ("unknown" as const)
                      : outcome.status === "not_attempted"
                        ? ("not_attempted" as const)
                        : ("failed" as const)
                    : sent.has(`${target.kind}:${target.id}`)
                      ? ("unknown" as const)
                      : ("not_attempted" as const),
              detail:
                outcome?.error ??
                (!outcome
                  ? sent.has(`${target.kind}:${target.id}`)
                    ? `Deletion outcome was not confirmed. Inspect Tableau before retrying. ${failure ?? ""}`
                    : `Deletion was not sent. ${failure ?? ""}`
                  : undefined),
            };
          });
          record(scope, {
            kind: "delete",
            title: "Delete results",
            summary: failure,
            finishedAt: Date.now(),
            items,
          });
          resultsRecorded = true;
          if (current(scope)) {
            deleteBatches = [];
            set({ deletePlan: null, deleteError: null });
          }
        } catch (error) {
          if (current(scope))
            set({ deletePlan: null, ...(resultsRecorded
              ? { deleteError: null, error: errorMessage(error) }
              : { deleteError: errorMessage(error) }) });
        } finally {
          if (current(scope)) set({ busy: null });
        }
      },
      dismissResults() {
        const outcomes = { ...get().outcomes };
        delete outcomes[activeKey()];
        set({ results: null, outcomes });
      },
      async follow(kind, operations, metrics, targets) {
        const scope = capture();
        if (!scope.context || get().busy || !get().mutationAvailable || get().cooldown) return operations;
        set({ busy: kind });
        const labels = {
          metricLabels: new Map(
            metrics.map((metric) => [metric.id, metric.label]),
          ),
          targetLabels: new Map(
            targets.map((target) => [
              targetLabelKey(target.kind, target.id),
              target.label,
            ]),
          ),
        };
        const results: Awaited<ReturnType<RegistryApi["follow"]>>["results"] =
          [];
        let sentCount = 0;
        let activeBatchStart = 0;
        let failure: string | undefined;
        try {
          for (let index = 0; index < operations.length; index += 200) {
            if (!current(scope)) {
              failure =
                "The connection or datasource changed. Remaining subscriptions were not sent.";
              break;
            }
            activeBatchStart = index;
            sentCount = index + Math.min(200, operations.length - index);
            const response = await get().trackProviderOperation(() => transport[kind](
              scope.context!,
              operations.slice(index, index + 200),
              scope.owner,
            ), scope.owner);
            captureThrottle(scope, response.throttle);
            for (const result of response.results) captureThrottle(scope, result.throttle);
            results.push(...response.results);
            if (response.terminated || response.stopped || response.throttle) {
              failure = response.terminated
                ? "The Tableau session ended. Remaining subscriptions were not sent."
                : response.throttle ? "Tableau is limiting requests. Remaining subscriptions were not sent."
                : "A subscription outcome is uncertain. Remaining subscriptions were not sent.";
              break;
            }
          }
        } catch (error) {
          captureCooldown(scope, error);
          if (error instanceof PulseApiError && error.status === 429 && error.throttle?.sent !== true) sentCount = activeBatchStart;
          failure = errorMessage(error);
        }
        const returnedPairs = new Set(
          results.map(
            (result) =>
              `${result.metricId}\u0000${result.targetKind}\u0000${result.targetId}`,
          ),
        );
        for (const [index, operation] of operations.entries()) {
          if (
            returnedPairs.has(
              `${operation.metricId}\u0000${operation.target.kind}\u0000${operation.target.id}`,
            )
          )
            continue;
          results.push({
            metricId: operation.metricId,
            targetId: operation.target.id,
            targetKind: operation.target.kind,
            status: index < sentCount ? "unknown" : "not_attempted",
            ok: false,
            error:
              failure ??
              (index < sentCount
                ? "The backend did not confirm this subscription. Check Tableau before retrying."
                : "This subscription was not sent."),
          });
        }
        const reconciled = reconcileFollowTargetResults(
          kind,
          operations,
          results,
          labels,
          failure,
        );
        record(scope, {
          kind,
          title: kind === "follow" ? "Follow results" : "Unfollow results",
          finishedAt: Date.now(),
          items: reconciled.items,
        });
        if (sentCount > 0) {
          const ids = [...new Set(results.filter(result => result.sent !== false && result.status !== "not_attempted").map(result => result.metricId))];
          supersedeDetails(scope, ids);
          invalidateCounts(scope, ids);
          if (!get().cooldown) await readFollowState(scope, ids, true);
          else if (ids.length) {
            const deferred = unavailableFollowState(ids, "Follow details changed. Reload them after the Tableau request limit clears.");
            for (const availability of Object.values(deferred.availabilityByMetricId ?? {})) {
              availability.relationshipStatus = "not_requested";
              availability.followerCountStatus = "not_requested";
            }
            const saved = cache.get(scope.key);
            if (saved) retain(scope.key, { ...saved, followState: replaceFollowMetrics(saved.followState, deferred, ids) });
            if (scope.key === activeKey()) set({ followState: replaceFollowMetrics(get().followState, deferred, ids) });
          }
        }
        if (current(scope)) set({ busy: null });
        return reconciled.retryOperations;
      },
      invalidateTargets(owner = get().owner) {
        const ownerKey = sessionOwnerKey(owner);
        directories.delete(ownerKey);
        directoryPending.delete(ownerKey);
      },
      async loadTargets(refresh = false) {
        const owner = get().owner;
        const ownerKey = sessionOwnerKey(owner);
        if (refresh) get().invalidateTargets();
        const saved = directories.get(ownerKey);
        if (saved && Date.now() - saved.loadedAt < (saved.value.errors.length ? 15_000 : 300_000)) return saved.value;
        const existing = directoryPending.get(ownerKey);
        if (existing) return existing;
        const request = get().trackProviderOperation(() => transport.followTargets(owner), owner);
        directoryPending.set(ownerKey, request);
        try {
          const value = await request;
          if (directoryPending.get(ownerKey) === request) {
            directories.set(ownerKey, { value, loadedAt: Date.now() });
            while (directories.size > 8) directories.delete(directories.keys().next().value!);
          }
          return value;
        } finally { if (directoryPending.get(ownerKey) === request) directoryPending.delete(ownerKey); }
      },
      async ensureFollowState(metricIds) {
        const ids = metricIds.filter((id) => {
          const status = get().followState?.availabilityByMetricId?.[id]?.relationshipStatus;
          return status === "not_requested" || status === undefined;
        });
        if (ids.length) await readFollowState(capture(), ids);
      },
      async loadMoreFollowState(metricIds) {
        const scope = capture();
        if (!metricIds.length || get().followLoading) return;
        supersedeDetails(scope, metricIds);
        set({ followLoading: true });
        try { await readFollowState(scope, metricIds, false, true); }
        finally { if (current(scope)) set({ followLoading: false }); }
      },
      async refreshFollowState(metricIds) {
        const scope = capture();
        supersedeDetails(scope, metricIds);
        const result = await readFollowState(scope, metricIds, true);
        return current(scope) ? result : null;
      },
      loadFollowers: (metricIds) => {
        const owner = get().owner;
        return get().trackProviderOperation(() => transport.followers(metricIds, owner), owner);
      },
    };
  });
}
export const useRegistry = createRegistryController();
