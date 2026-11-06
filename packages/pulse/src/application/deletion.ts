import { getSessionContext, isSessionCurrent } from "@pulse-metric-studio/core";
import type { TableauSession } from "@pulse-metric-studio/core";
import type {
  ExecutePulseDeleteRequest,
  PreparePulseDeleteRequest,
  PulseDeletePlan,
} from "@pulse-metric-studio/shared";
import { requirePulseOwner } from "./context.js";
import { executeDeletes } from "./delete-execution.js";
import { PulseApplicationError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { getPulseInventorySnapshot, patchPulseInventory, beginInventoryMutation, endInventoryMutation } from "./inventory-snapshots.js";
import type { ExistingMetricsResult } from "./inventory.js";

export interface DeleteDependencies {
  /** Resolves the displayed immutable snapshot without contacting Tableau. */
  inventory: (
    session: TableauSession,
    context: PreparePulseDeleteRequest["context"],
    snapshotId: string,
  ) => ExistingMetricsResult | Promise<ExistingMetricsResult>;
  execute: typeof executeDeletes;
}
export class PulseDeletionService {
  constructor(
    private readonly dependencies: DeleteDependencies = {
      inventory: getPulseInventorySnapshot,
      execute: executeDeletes,
    },
  ) {}
  private async plan(
    request: PreparePulseDeleteRequest,
    session: TableauSession,
  ): Promise<PulseDeletePlan> {
    requirePulseOwner(request.context, session);
    const inventory = await this.dependencies.inventory(
      session,
      request.context,
      request.snapshotId,
    );
    requirePulseOwner(request.context, session);
    const definitionIds = [...new Set(request.definitionIds)].sort();
    const metricIds = [...new Set(request.metricIds)].sort();
    if (!definitionIds.length && !metricIds.length)
      throw new PulseApplicationError(
        "delete_selection_empty",
        "Select at least one resource to delete.",
      );
    // Incomplete inventory affects the displayed reach, never target ownership.
    // Only identities in this datasource's displayed snapshot authorize deletes.
    const override = request.allowIncompleteInventory;
    const targets: PulseDeletePlan["targets"] = [];
    for (const definitionId of definitionIds) {
      const definition = inventory.definitions.find(
        (entry) => entry.definitionId === definitionId,
      );
      if (!definition) throw selectionUnavailable();
      const inventoryComplete =
        !inventory.truncated &&
        definition.inventoryStatus === "complete";
      if (!inventoryComplete && !override)
        throw new PulseApplicationError(
          "delete_inventory_incomplete",
          "Tableau did not return the complete current inventory for this definition.",
          409,
        );
      const affectedMetricIds = definition.metrics
        .map((entry) => entry.metricId)
        .sort();
      targets.push({
        kind: "definition",
        id: definitionId,
        name: definition.name,
        definitionId,
        inventoryComplete,
        affectedMetricIds,
      });
    }
    for (const metricId of metricIds) {
      const definition = inventory.definitions.find((entry) =>
        entry.metrics.some((metric) => metric.metricId === metricId),
      );
      const metric = definition?.metrics.find(
        (entry) => entry.metricId === metricId,
      );
      if (!definition || !metric) throw selectionUnavailable();
      if (definitionIds.includes(definition.definitionId)) continue;
      if (metric.isDefault !== false)
        throw new PulseApplicationError(
          "delete_default_metric",
          "Default metrics require an explicit whole-definition deletion review.",
          409,
        );
      targets.push({
        kind: "metric",
        id: metricId,
        name: metric.name || definition.name,
        definitionId: definition.definitionId,
        inventoryComplete: true,
        affectedMetricIds: [metricId],
      });
    }
    const previewFingerprint = fingerprint({
      context: request.context,
      snapshotId: request.snapshotId,
      override,
      targets,
    });
    const metricNames = new Map(inventory.definitions.flatMap((definition) =>
      definition.metrics.map((metric) =>
        [metric.metricId, metric.name || definition.name] as const)));
    for (const target of targets)
      target.affectedMetrics = target.affectedMetricIds.map((id) => ({
        id, name: metricNames.get(id) ?? id, followerCount: null,
      }));
    const warnings: string[] = [];
    if (definitionIds.length)
      warnings.push(
        "Deleting a definition also removes its metrics and their subscriptions.",
      );
    if (targets.some((target) => !target.inventoryComplete))
      warnings.push(
        "Tableau could not list every metric for the resources marked incomplete. They are deleted by ID, including metrics and subscriptions this review cannot show.",
      );
    return {
      context: request.context,
      snapshotId: request.snapshotId,
      metricIds,
      definitionIds,
      allowIncompleteInventory: override,
      targets,
      warnings,
      previewFingerprint,
    };
  }
  preview(request: PreparePulseDeleteRequest): Promise<PulseDeletePlan> {
    return this.plan(request, requirePulseOwner(request.context));
  }
  async execute(request: ExecutePulseDeleteRequest) {
    const session = requirePulseOwner(request.context);
    const capturedContext = getSessionContext(session);
    const plan = await this.plan(request, session);
    if (plan.previewFingerprint !== request.previewFingerprint)
      throw new PulseApplicationError(
        "delete_plan_changed",
        "The deletion selection does not match its reviewed plan. Review the selection again.",
        409,
      );
    requirePulseOwner(request.context, session);
    beginInventoryMutation(session, request.context, request.snapshotId);
    try {
    const result = await this.dependencies.execute(
      session,
      plan.targets.map((target) =>
        target.kind === "definition"
          ? { definitionId: target.id, metricIds: [], name: target.name }
          : { metricIds: [target.id], name: target.name },
      ),
    );
    if (getSessionContext(session) === capturedContext && (!capturedContext || isSessionCurrent(session))) {
      const confirmed = result.outcomes.filter(outcome => outcome.status === 'deleted' || outcome.status === 'already_absent');
      if (confirmed.length) result.inventoryPatch = patchPulseInventory(session, request.context, request.snapshotId, {
        upserts: [],
        removedMetricIds: confirmed.flatMap(outcome => outcome.metricId ? [outcome.metricId] : []),
        removedDefinitionIds: confirmed.flatMap(outcome => outcome.definitionId ? [outcome.definitionId] : []),
      });
    }
    return result;
    } finally { endInventoryMutation(session, request.context, request.snapshotId); }
  }
}

function selectionUnavailable(): PulseApplicationError {
  return new PulseApplicationError(
    "delete_selection_unavailable",
    "A selected resource is absent from the displayed datasource inventory. Refresh metrics and review the selection again.",
    409,
  );
}
