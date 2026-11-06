import type { TableauSession } from "@pulse-metric-studio/core";
import { runPacedMutationBlocks, tableauMutationProgress, TableauError, TableauMutationPacer } from "@pulse-metric-studio/core";
import type { PulseDeleteResult } from "@pulse-metric-studio/shared";
import { pulseOperationErrorMessage } from '../pulse/operation-errors.js';
import { deleteDefinition, deleteMetric } from "../pulse/pulse-client.js";

import { mutationMetadata, latestThrottle } from './mutation-metadata.js';
import { invalidatePulseDefinitionInventory } from "./inventory.js";
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
  const settle = (outcome: DeleteOutcome) => { outcomes.push(outcome); tableauMutationProgress.completed(); };

  const classifyFailure = (error: unknown): "failed" | "unknown" | "not_attempted" => {
    if (error && typeof error === "object" && "sent" in error && error.sent === false) { stopped = true; return "not_attempted"; }
    const unknown =
      !(error instanceof TableauError) ||
      error.kind === "network" ||
      error.status >= 500;
    if (unknown || (error instanceof TableauError && error.kind === "auth"))
      stopped = true;

    return unknown ? "unknown" : "failed";
  };
  const deletingDefinitionIds = new Set(
    entries
      .filter((entry) => entry.definitionId)
      .map((entry) => entry.definitionId!),
  );

  const metricEntries = entries
    .flatMap((entry) =>
      entry.metricIds.map((metricId) => ({
        definitionId: entry.definitionId,
        metricId,
      })),
    )
    .filter((entry) => !deletingDefinitionIds.has(entry.definitionId ?? ""));
  tableauMutationProgress.total(deletingDefinitionIds.size + metricEntries.length);

  // Definition deletes cascade to every metric under them, so they go one at a
  // time and the batch can stop before the next one is sent.
  const definitionPacer = new TableauMutationPacer();
  for (const entry of entries.filter((candidate) => candidate.definitionId)) {
    if (stopped) {
      settle({
        definitionId: entry.definitionId!,
        status: "not_attempted",
        sent: false,
        error: "The deletion batch stopped before this resource was sent.",
      });
      continue;
    }
    try {
      await definitionPacer.send(() => deps.deleteDefinition(session, entry.definitionId!));
      definitionsDeleted++;
      settle({ definitionId: entry.definitionId!, status: "deleted", sent: true });
    } catch (error) {
      if (error instanceof TableauError && error.status === 404) {
        definitionsDeleted++;
        settle({
          definitionId: entry.definitionId!,
          status: "already_absent",
          sent: true,
        });
        continue;
      }
      settle({
        definitionId: entry.definitionId!,
        status: classifyFailure(error),
        ...mutationMetadata(error),
        error: pulseOperationErrorMessage(error, 'delete', [session.token]),
      });
      failures.push(
        `definition ${entry.definitionId} (${entry.name}): ${pulseOperationErrorMessage(error, 'delete', [session.token])}`,
      );
    }
  }
  let metricsDeleted = 0;
  const metricResults = await runPacedMutationBlocks(metricEntries, async (entry) => {
        if (stopped) {
          settle({
            metricId: entry.metricId,
            status: "not_attempted",
            sent: false,
            error: "The deletion batch stopped before this resource was sent.",
          });
          return false;
        }
        try {
          await deps.deleteMetric(session, entry.metricId);
          settle({ metricId: entry.metricId, status: "deleted", sent: true });
          return true;
        } catch (error) {
          if (error instanceof TableauError && error.status === 404) {
            settle({ metricId: entry.metricId, status: "already_absent", sent: true });
            return true;
          }
          settle({
            metricId: entry.metricId,
            status: classifyFailure(error),
        ...mutationMetadata(error),
            error: pulseOperationErrorMessage(error, 'delete', [session.token]),
          });
          failures.push(
            `metric ${entry.metricId}: ${pulseOperationErrorMessage(error, 'delete', [session.token])}`,
          );
          return false;
        }
  });
  metricsDeleted += metricResults.filter(Boolean).length;

  if (definitionsDeleted > 0) invalidatePulseDefinitionInventory(session);

  const throttle = latestThrottle(outcomes);
  if (throttle) for (const outcome of outcomes) if (outcome.sent === false && !outcome.throttle) outcome.throttle = { ...throttle, sent: false };
  return {
    ...(throttle ? { throttle, sent: outcomes.some(outcome => outcome.sent === true) } : {}),
    definitionsDeleted,
    metricsDeleted,
    failures,
    outcomes,
  };
}
