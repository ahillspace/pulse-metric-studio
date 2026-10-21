import type { TableauSession } from "@pulse-metric-studio/core";
import type {
  ExecutePulseDeleteRequest,
  PreparePulseDeleteRequest,
  PulseDeletePlan,
} from "@pulse-metric-studio/shared";
import { compareCanonicalStrings } from "@pulse-metric-studio/shared";
import { requirePulseOwner } from "./context.js";
import { executeDeletes } from "./delete-execution.js";
import { PulseApplicationError } from "./errors.js";
import { fingerprint } from "./fingerprint.js";
import { batchGetFollowerCounts } from "../pulse/pulse-client.js";
import {
  getExistingMetrics,
  invalidatePulseDefinitionInventory,
} from "./inventory.js";

export interface DeleteDependencies {
  inventory: typeof getExistingMetrics;
  execute: typeof executeDeletes;
  followerCounts?: typeof batchGetFollowerCounts;
}
export class PulseDeletionService {
  constructor(
    private readonly dependencies: DeleteDependencies = {
      inventory: getExistingMetrics,
      execute: executeDeletes,
      followerCounts: batchGetFollowerCounts,
    },
  ) {}
  private async plan(
    request: PreparePulseDeleteRequest,
    session: TableauSession,
    includeDetails = true,
  ): Promise<PulseDeletePlan> {
    invalidatePulseDefinitionInventory(session);
    const inventory = await this.dependencies.inventory(
      session,
      request.context.datasourceLuid,
    );
    requirePulseOwner(request.context, session);
    const definitionIds = [...new Set(request.definitionIds)].sort();
    const metricIds = [...new Set(request.metricIds)].sort();
    if (!definitionIds.length && !metricIds.length)
      throw new PulseApplicationError(
        "delete_selection_empty",
        "Select at least one resource to delete.",
      );
    // An override deletes by ID: inventory still supplies names and the
    // default-metric guard, but its contents no longer gate the deletion and
    // are left out of the fingerprint, so a reload Tableau throttles
    // differently after review cannot invalidate the confirmed plan.
    const override = request.allowIncompleteInventory;
    const targets: PulseDeletePlan["targets"] = [];
    const relevant: unknown[] = [];
    for (const definitionId of definitionIds) {
      const definition = inventory.definitions.find(
        (entry) => entry.definitionId === definitionId,
      );
      const inventoryComplete =
        !!definition &&
        !inventory.truncated &&
        definition.inventoryStatus === "complete";
      if (!inventoryComplete && !override)
        throw new PulseApplicationError(
          "delete_inventory_incomplete",
          "Tableau did not return the complete current inventory for this definition.",
          409,
        );
      const affectedMetricIds = (definition?.metrics ?? [])
        .map((entry) => entry.metricId)
        .sort();
      targets.push({
        kind: "definition",
        id: definitionId,
        name: definition?.name ?? definitionId,
        definitionId,
        inventoryComplete,
        affectedMetricIds,
      });
      if (definition && !override)
        relevant.push({
          ...definition,
          metrics: [...definition.metrics].sort((left, right) =>
            compareCanonicalStrings(left.metricId, right.metricId),
          ),
        });
    }
    for (const metricId of metricIds) {
      const definition = inventory.definitions.find((entry) =>
        entry.metrics.some((metric) => metric.metricId === metricId),
      );
      const metric = definition?.metrics.find(
        (entry) => entry.metricId === metricId,
      );
      if (!definition || !metric) {
        if (!override)
          throw new PulseApplicationError(
            "delete_metric_unavailable",
            "A selected metric is absent from current inventory. Reload the registry.",
            409,
          );
        targets.push({
          kind: "metric",
          id: metricId,
          name: metricId,
          definitionId: null,
          inventoryComplete: false,
          affectedMetricIds: [metricId],
        });
        continue;
      }
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
      if (!override) relevant.push({ definitionId: definition.definitionId, metric });
    }
    const previewFingerprint = fingerprint({
      context: request.context,
      override,
      targets: override
        ? targets.map(({ kind, id }) => ({ kind, id }))
        : targets,
      relevant,
    });
    if (includeDetails) {
      const metricNames = new Map(
        inventory.definitions.flatMap((definition) =>
          definition.metrics.map(
            (metric) =>
              [metric.metricId, metric.name || definition.name] as const,
          ),
        ),
      );
      const ids = [
        ...new Set(targets.flatMap((target) => target.affectedMetricIds)),
      ];
      let counts: Record<string, number> = {};
      try {
        if (this.dependencies.followerCounts)
          counts = (await this.dependencies.followerCounts(session, ids))
            .countsByMetricId;
      } catch {
        /* Unknown follower reach never becomes a confirmed zero. */
      }
      requirePulseOwner(request.context, session);
      for (const target of targets)
        target.affectedMetrics = target.affectedMetricIds.map((id) => ({
          id,
          name: metricNames.get(id) ?? id,
          followerCount: counts[id] ?? null,
        }));
    }
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
    const plan = await this.plan(request, session, false);
    if (plan.previewFingerprint !== request.previewFingerprint)
      throw new PulseApplicationError(
        "delete_plan_changed",
        "Affected resources changed. Review a new deletion preview.",
        409,
      );
    requirePulseOwner(request.context, session);
    return this.dependencies.execute(
      session,
      plan.targets.map((target) =>
        target.kind === "definition"
          ? { definitionId: target.id, metricIds: [], name: target.name }
          : { metricIds: [target.id], name: target.name },
      ),
    );
  }
}
