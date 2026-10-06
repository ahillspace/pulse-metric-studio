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
    const targets: PulseDeletePlan["targets"] = [];
    const relevant: unknown[] = [];
    for (const definitionId of definitionIds) {
      const definition = inventory.definitions.find(
        (entry) => entry.definitionId === definitionId,
      );
      if (
        !definition ||
        inventory.truncated ||
        definition.inventoryStatus !== "complete"
      )
        throw new PulseApplicationError(
          "delete_inventory_incomplete",
          "Complete current inventory is required before deleting a definition.",
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
        affectedMetricIds,
      });
      relevant.push(definition);
    }
    for (const metricId of metricIds) {
      const definition = inventory.definitions.find((entry) =>
        entry.metrics.some((metric) => metric.metricId === metricId),
      );
      const metric = definition?.metrics.find(
        (entry) => entry.metricId === metricId,
      );
      if (!definition || !metric)
        throw new PulseApplicationError(
          "delete_metric_unavailable",
          "A selected metric is absent from current inventory. Reload the registry.",
          409,
        );
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
        affectedMetricIds: [metricId],
      });
      relevant.push({ definitionId: definition.definitionId, metric });
    }
    const previewFingerprint = fingerprint({
      context: request.context,
      targets,
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
    return {
      context: request.context,
      metricIds,
      definitionIds,
      targets,
      warnings: definitionIds.length
        ? [
            "Deleting a definition also removes its metrics and their subscriptions.",
          ]
        : [],
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
