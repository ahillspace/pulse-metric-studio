import type { TableauSession } from "@pulse-metric-studio/core";
import { TableauError } from "@pulse-metric-studio/core";
import type { PulseDeleteResult } from "@pulse-metric-studio/shared";
import {
  boundedProviderDiagnostic,
  diagnosticMessage,
} from "../pulse/provider-diagnostics.js";
import { deleteDefinition, deleteMetric } from "../pulse/pulse-client.js";

import { invalidatePulseDefinitionInventory } from "./inventory.js";
import { mapWithConcurrency } from "./registry-collections.js";
const PROVIDER_CONCURRENCY = 5;
export interface DeletePlanEntry {
  definitionId?: string;
  metricIds: string[];
  name: string;
}

/** Injectable delete client, so the invalidation contract is unit-testable. */
export interface ExecuteDeletesDependencies {
  deleteDefinition: typeof deleteDefinition;
  deleteMetric: typeof deleteMetric;
}

export type DeleteOutcome = PulseDeleteResult["outcomes"][number];

export async function executeDeletes(
  session: TableauSession,
  entries: DeletePlanEntry[],
  deps: ExecuteDeletesDependencies = { deleteDefinition, deleteMetric },
): Promise<PulseDeleteResult> {
  const failures: string[] = [];
  const outcomes: DeleteOutcome[] = [];
  let definitionsDeleted = 0;
  let stopped = false;
  let uncertain = false;
  const classifyFailure = (error: unknown): "failed" | "unknown" => {
    const unknown =
      !(error instanceof TableauError) ||
      error.kind === "network" ||
      error.status >= 500;
    if (unknown || (error instanceof TableauError && error.kind === "auth"))
      stopped = true;
    uncertain ||= unknown;
    return unknown ? "unknown" : "failed";
  };
  const deletingDefinitionIds = new Set(
    entries
      .filter((entry) => entry.definitionId)
      .map((entry) => entry.definitionId!),
  );

  for (const entry of entries.filter((candidate) => candidate.definitionId)) {
    if (stopped) {
      outcomes.push({
        definitionId: entry.definitionId!,
        status: "not_attempted",
        error: "The deletion batch stopped before this resource was sent.",
      });
      continue;
    }
    try {
      await deps.deleteDefinition(session, entry.definitionId!);
      definitionsDeleted++;
      outcomes.push({ definitionId: entry.definitionId!, status: "deleted" });
    } catch (error) {
      if (error instanceof TableauError && error.status === 404) {
        definitionsDeleted++;
        outcomes.push({
          definitionId: entry.definitionId!,
          status: "already_absent",
        });
        continue;
      }
      outcomes.push({
        definitionId: entry.definitionId!,
        status: classifyFailure(error),
        error: diagnosticMessage(boundedProviderDiagnostic(error)),
      });
      failures.push(
        `definition ${entry.definitionId} (${entry.name}): ${diagnosticMessage(boundedProviderDiagnostic(error))}`,
      );
    }
  }
  const metricEntries = entries
    .flatMap((entry) =>
      entry.metricIds.map((metricId) => ({
        definitionId: entry.definitionId,
        metricId,
      })),
    )
    .filter((entry) => !deletingDefinitionIds.has(entry.definitionId ?? ""));
  const metricResults = await mapWithConcurrency(
    metricEntries,
    PROVIDER_CONCURRENCY,
    async (entry) => {
      if (stopped) {
        outcomes.push({
          metricId: entry.metricId,
          status: "not_attempted",
          error: "The deletion batch stopped before this resource was sent.",
        });
        return false;
      }
      try {
        await deps.deleteMetric(session, entry.metricId);
        outcomes.push({ metricId: entry.metricId, status: "deleted" });
        return true;
      } catch (error) {
        if (error instanceof TableauError && error.status === 404) {
          outcomes.push({ metricId: entry.metricId, status: "already_absent" });
          return true;
        }
        outcomes.push({
          metricId: entry.metricId,
          status: classifyFailure(error),
          error: diagnosticMessage(boundedProviderDiagnostic(error)),
        });
        failures.push(
          `metric ${entry.metricId}: ${diagnosticMessage(boundedProviderDiagnostic(error))}`,
        );
        return false;
      }
    },
  );
  const metricsDeleted = metricResults.filter(Boolean).length;

  // An exact metric is part of its definition's cached inventory, so a
  // metric-only delete must invalidate the inventory too - otherwise the next
  // getExistingMetrics call (within the cache TTL) returns the stale list still
  // containing the deleted metric, and the UI looks like the delete did nothing.
  if (definitionsDeleted > 0 || metricsDeleted > 0 || uncertain)
    invalidatePulseDefinitionInventory(session);

  return {
    definitionsDeleted,
    metricsDeleted,
    failures,
    outcomes,
  };
}
