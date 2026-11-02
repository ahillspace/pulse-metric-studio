import { create } from "zustand";
import type {
  PulseDeletePlan,
  PulseDraftContext,
  PulseFollowersDetail,
  PulseFollowOperation,
  PulseInventoryResponse,
  PulseVariantRequestV1,
} from "@pulse-metric-studio/shared";
import { registryApi, type RegistryApi } from "../api/registry";
import { pulseApi, PulseApiError, type PulseApi } from "../api/client";
import {
  forkRegistryActionItem,
  type RegistryActionResults,
} from "../registry-actions";
import { mergeFollowStates, unavailableFollowState } from "../follow-state";
import type { FollowState } from "./view-types";
import {
  reconcileFollowTargetResults,
  type FollowTargetChoice,
  targetLabelKey,
} from "../follow-target-actions";
import { errorMessage } from "../shell/notifications";

interface RegistryState {
  context: PulseDraftContext | null;
  datasourceName: string;
  inventory: PulseInventoryResponse | null;
  followState: FollowState | null;
  loading: boolean;
  followLoading: boolean;
  error: string | null;
  busy: "fork" | "delete" | "follow" | "unfollow" | null;
  results: RegistryActionResults | null;
  outcomes: Record<string, RegistryActionResults>;
  createdMetricIds: string[];
  deletePlan: PulseDeletePlan | null;
  deleteLoading: boolean;
  deleteError: string | null;
  /** The last review stopped because Tableau did not return complete inventory. */
  deleteOverridable: boolean;
  setContext: (
    context: PulseDraftContext | null,
    datasourceName?: string,
  ) => void;
  load: () => Promise<void>;
  ensureLoaded: () => Promise<void>;
  invalidate: (context?: PulseDraftContext | null) => Promise<void>;
  fork: (
    request: PulseVariantRequestV1,
    labels: Map<string, string>,
  ) => Promise<void>;
  previewDelete: (
    metricIds: string[],
    definitionIds: string[],
    allowIncompleteInventory?: boolean,
  ) => Promise<void>;
  /** Reviews the last selection again as a deletion by ID. */
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
  loadTargets: RegistryApi["followTargets"];
  /** Reads a fresh, selection-scoped identity snapshot without replacing inventory state. */
  refreshFollowState: (metricIds: string[]) => Promise<FollowState | null>;
  loadFollowers: (
    metricIds: string[],
  ) => Promise<{ details: PulseFollowersDetail[] }>;
}
function key(context: PulseDraftContext | null): string {
  return context ? JSON.stringify([context.connectionId, context.serverUrl, context.siteId, context.datasourceLuid]) : "null";
}

export function createRegistryController(
  transport: RegistryApi = registryApi,
  deletion: Pick<PulseApi, "previewDelete" | "delete"> = pulseApi,
) {
  const cache = new Map<string, { inventory: PulseInventoryResponse; followState: FollowState | null; loadedAt: number }>();
  let pending: { generation: number; promise: Promise<void> } | null = null;
  let generation = 0;
  let inventoryRequest = 0;
  let deleteRequest = 0;
  let deleteBatches: PulseDeletePlan[] = [];
  let deleteSelection: { metricIds: string[]; definitionIds: string[] } | null =
    null;
  const INCOMPLETE_INVENTORY_CODES = [
    "delete_inventory_incomplete",
    "delete_metric_unavailable",
  ];
  const overridable = (error: unknown) =>
    error instanceof PulseApiError &&
    INCOMPLETE_INVENTORY_CODES.includes(error.code ?? "");
  return create<RegistryState>((set, get) => {
    const capture = () => ({ context: get().context, generation });
    const current = (scope: ReturnType<typeof capture>) =>
      scope.generation === generation &&
      key(scope.context) === key(get().context);
    const record = (
      scope: ReturnType<typeof capture>,
      results: RegistryActionResults,
    ) =>
      set((state) => ({
        outcomes: { ...state.outcomes, [key(scope.context)]: results },
        ...(current(scope) ? { results } : {}),
      }));
    return {
      context: null,
      datasourceName: "",
      inventory: null,
      followState: null,
      loading: false,
      followLoading: false,
      error: null,
      busy: null,
      results: null,
      outcomes: {},
      createdMetricIds: [],
      deletePlan: null,
      deleteLoading: false,
      deleteError: null,
      deleteOverridable: false,
      setContext(context, datasourceName = "") {
        if (key(context) === key(get().context)) {
          if (datasourceName !== get().datasourceName) set({ datasourceName });
          return;
        }
        generation += 1;
        inventoryRequest += 1;
        deleteRequest += 1;
        deleteBatches = [];
        deleteSelection = null;
        const saved = cache.get(key(context));
        set({
          context,
          datasourceName,
          inventory: saved?.inventory ?? null,
          followState: saved?.followState ?? null,
          followLoading: false,
          loading: false,
          error: null,
          busy: null,
          results: get().outcomes[key(context)] ?? null,
          createdMetricIds: [],
          deletePlan: null,
          deleteLoading: false,
          deleteError: null,
          deleteOverridable: false,
        });
      },
      async ensureLoaded() {
        if (!get().context) return;
        if (pending?.generation === generation) return pending.promise;
        const saved = cache.get(key(get().context));
        if (saved && Date.now() - saved.loadedAt < 60_000) return;
        const promise = get().load();
        const run = { generation, promise };
        pending = run;
        try { await promise; } finally { if (pending === run) pending = null; }
      },
      async invalidate(context = get().context) {
        if (!context) return;
        cache.delete(key(context));
        if (key(context) === key(get().context)) await get().load();
      },
      async load() {
        const scope = capture();
        if (!scope.context) return;
        const request = ++inventoryRequest;
        set({ loading: true, error: null });
        try {
          const inventory = await transport.inventory(scope.context);
          if (!current(scope) || request !== inventoryRequest) return;
          cache.set(key(scope.context), { inventory, followState: get().followState, loadedAt: Date.now() });
          set({ inventory, loading: false, followLoading: true });
          const ids = inventory.definitions.flatMap((definition) =>
            definition.metrics.map((metric) => metric.metricId),
          );
          const batches: string[][] = [];
          for (let index = 0; index < ids.length; index += 200)
            batches.push(ids.slice(index, index + 200));
          const states: FollowState[] = [];
          const previous = get().followState;
          for (let index = 0; index < batches.length; index += 4) {
            if (!current(scope) || request !== inventoryRequest) return;
            await Promise.all(
              batches.slice(index, index + 4).map(async (batch) => {
                let result: FollowState;
                try {
                  result = await transport.followState(batch);
                } catch (error) {
                  result = unavailableFollowState(batch, errorMessage(error));
                }
                if (!current(scope) || request !== inventoryRequest) return;
                states.push(result);
                set({
                  followState: mergeFollowStates([
                    ...(previous ? [previous] : []),
                    ...states,
                  ]),
                });
              }),
            );
          }
          if (current(scope) && request === inventoryRequest) {
            cache.set(key(scope.context), { inventory, followState: ids.length ? mergeFollowStates(states) : null, loadedAt: Date.now() });
            set({
              followState: ids.length ? mergeFollowStates(states) : null,
              followLoading: false,
            });
          }
        } catch (error) {
          if (current(scope) && request === inventoryRequest)
            set({
              error: errorMessage(error),
              loading: false,
              followLoading: false,
            });
        }
      },
      async fork(request, labels) {
        const scope = capture();
        if (!scope.context || get().busy) return;
        set({ busy: "fork", error: null });
        try {
          const summary = await transport.fork(scope.context, request);
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
          record(scope, {
            kind: "fork",
            title: "Variant results",
            finishedAt: Date.now(),
            items: request.sourceMetricIds.map((metricId) => ({
              key: `fork:${metricId}`,
              metricId,
              metricLabel: labels.get(metricId) ?? metricId,
              status: "failed",
              creationStatus: "unknown",
              detail: `The request did not return a receipt. Inspect Tableau before retrying. ${errorMessage(error)}`,
            })),
          });
        } finally {
          await get().invalidate(scope.context);
          if (current(scope)) set({ busy: null });
        }
      },
      async previewDelete(
        metricIds,
        definitionIds,
        allowIncompleteInventory = false,
      ) {
        const scope = capture();
        if (!scope.context || get().busy) return;
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
          const definitions = [...new Set(definitionIds)];
          const covered = new Set(
            get()
              .inventory?.definitions.filter((definition) =>
                definitions.includes(definition.definitionId),
              )
              .flatMap((definition) =>
                definition.metrics.map((metric) => metric.metricId),
              ) ?? [],
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
              metricIds: metrics.slice(offset, offset + 1000),
              definitionIds: definitions.slice(offset, offset + 1000),
              allowIncompleteInventory,
            });
            if (!current(scope) || request !== deleteRequest) return;
            plans.push(plan);
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
        if (!scope.context || !plan || get().busy) return;
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
            const response = await deletion.delete({
              context: batch.context,
              metricIds: batch.metricIds,
              definitionIds: batch.definitionIds,
              previewFingerprint: batch.previewFingerprint,
              allowIncompleteInventory: batch.allowIncompleteInventory,
            });
            outcomes.push(...response.outcomes);
            if (response.failures.length) {
              failure = response.failures.join(" ");
              break;
            }
          }
        } catch (error) {
          failure = errorMessage(error);
          if (
            error instanceof PulseApiError &&
            [400, 401, 409, 422].includes(error.status)
          ) {
            activeBatch?.targets.forEach((target) =>
              sent.delete(`${target.kind}:${target.id}`),
            );
            if (!outcomes.length) {
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
            finishedAt: Date.now(),
            items,
          });
          if (current(scope)) {
            deleteBatches = [];
            set({ deletePlan: null, deleteError: failure ?? null });
            await get().invalidate(scope.context);
          } else cache.delete(key(scope.context));
        } catch (error) {
          if (current(scope))
            set({ deleteError: errorMessage(error), deletePlan: null });
        } finally {
          if (current(scope)) set({ busy: null });
        }
      },
      dismissResults() {
        const outcomes = { ...get().outcomes };
        delete outcomes[key(get().context)];
        set({ results: null, outcomes });
      },
      async follow(kind, operations, metrics, targets) {
        const scope = capture();
        if (!scope.context || get().busy) return operations;
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
        let failure: string | undefined;
        try {
          for (let index = 0; index < operations.length; index += 200) {
            if (!current(scope)) {
              failure =
                "The connection or datasource changed. Remaining subscriptions were not sent.";
              break;
            }
            sentCount = index + Math.min(200, operations.length - index);
            const response = await transport[kind](
              scope.context,
              operations.slice(index, index + 200),
            );
            results.push(...response.results);
            if (response.terminated || response.stopped) {
              failure = response.terminated
                ? "The Tableau session ended. Remaining subscriptions were not sent."
                : "A subscription outcome is uncertain. Remaining subscriptions were not sent.";
              break;
            }
          }
        } catch (error) {
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
        if (sentCount > 0) await get().invalidate(scope.context);
        if (current(scope)) set({ busy: null });
        return reconciled.retryOperations;
      },
      loadTargets: () => transport.followTargets(),
      async refreshFollowState(metricIds) {
        const scope = capture();
        if (!scope.context) return null;
        const ids = [...new Set(metricIds)];
        const states: FollowState[] = [];
        for (let offset = 0; offset < ids.length; offset += 800) {
          if (!current(scope)) return null;
          const batches = Array.from({ length: Math.ceil(Math.min(800, ids.length - offset) / 200) },
            (_, index) => ids.slice(offset + index * 200, offset + (index + 1) * 200));
          states.push(...await Promise.all(batches.map(async (batch) => {
            try { return await transport.followState(batch); }
            catch (error) { return unavailableFollowState(batch, errorMessage(error)); }
          })));
        }
        return current(scope) ? mergeFollowStates(states) : null;
      },
      loadFollowers: (metricIds) => transport.followers(metricIds),
    };
  });
}
export const useRegistry = createRegistryController();
