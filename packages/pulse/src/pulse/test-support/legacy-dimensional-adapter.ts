// Translates historical behavior fixtures to the sole production variant planner.
import type { TableauSession } from '@pulse-metric-studio/core';
import {
  canonicalizeDimensionalForkRequest,
  type DimensionalForkSummary,
} from '@pulse-metric-studio/shared';
import {
  PulseDimensionalForkService as DimensionQueries,
  PulseDimensionalForkError,
  fingerprintValues,
  type PulseDimensionalForkDependencies as QueryDependencies,
} from '../dimensional-fork-service.js';
import type { MetricReconciliationResult } from '../reconciliation.js';
const providerFailureCount = Symbol('providerFailureCount');
type InternalDimensionalForkSummary = DimensionalForkSummary & {
  [providerFailureCount]?: number;
};
export interface PulseDimensionalForkDependencies extends QueryDependencies {
  getOrCreate(
    session: TableauSession,
    input: { definitionId: string; specification: Record<string, unknown> },
  ): Promise<{
    metricId: string | null;
    metricApiName?: string;
    created: boolean;
  }>;
  reconcile(
    session: TableauSession,
    input: { metricId: string; definitionId: string; datasourceLuid: string },
  ): Promise<MetricReconciliationResult>;
}
export class PulseDimensionalForkService extends DimensionQueries {
  constructor(
    private readonly legacyDependencies: PulseDimensionalForkDependencies,
  ) {
    super(legacyDependencies);
  }
  /** Compatibility adapter; all remote mutations run through the canonical planner. */
  async forkMetrics(
    session: TableauSession,
    input: unknown,
  ): Promise<DimensionalForkSummary> {
    const request = canonicalizeDimensionalForkRequest(input);
    const { PulseForkPlanService, forkPlanHttpStatus } = await import(
      '../fork-plan-service.js'
    );
    const responseNames = new Map<string, string>();
    const canonical = await new PulseForkPlanService({
      ...this.legacyDependencies,
      getOrCreate: async (owner, command) => {
        const response = await this.legacyDependencies.getOrCreate(
          owner,
          command,
        );
        if (response.metricId && response.metricApiName)
          responseNames.set(response.metricId, response.metricApiName);
        return response;
      },
    }).forkMetrics(session, {
      version: 1,
      sourceMetricIds: request.sourceMetricIds,
      clauses: [{ fieldId: request.fieldId, selection: request.selection }],
    });
    const domainFailure = canonical.results.find((result) =>
      result.error?.includes('not in the current domain'),
    );
    if (domainFailure)
      throw new PulseDimensionalForkError(
        'One or more selected values are not present in the current provider domain.',
        422,
      );
    const summary: InternalDimensionalForkSummary = {
      attempted: canonical.attempted,
      created: canonical.created,
      existing: canonical.existing,
      failed: canonical.failed,
      notAttempted: canonical.notAttempted,
      terminated: canonical.terminated,
      results: canonical.results.map((result) => ({
        sourceMetricId: result.sourceMetricId,
        fieldId: request.fieldId,
        valueFingerprint: fingerprintValues(request.selection.values),
        status:
          result.status === 'failed' || result.status === 'ownership_mismatch'
            ? 'failed'
            : result.creationStatus === 'created'
              ? 'created'
              : 'existing',
        creationStatus: result.creationStatus,
        createdMetricId: result.metricId,
        ...(result.metricId && responseNames.has(result.metricId)
          ? { createdApiName: responseNames.get(result.metricId) }
          : {}),
        requestedSpecification: result.requestedSpecification,
        reconciliationStatus: result.reconciliationStatus,
        ownershipVerified: result.reconciliationStatus === 'visible',
        exactMetricResolved: result.reconciliationStatus === 'visible',
        inventoryVisible: result.reconciliationStatus === 'visible',
        ...(result.error ? { error: result.error } : {}),
      })),
    };
    Object.defineProperty(summary, providerFailureCount, {
      value: forkPlanHttpStatus(canonical) === 502 ? summary.failed : 0,
    });
    return summary;
  }
}
export function dimensionalForkHttpStatus(
  summary: DimensionalForkSummary,
): 200 | 207 | 422 | 502 {
  const successful = summary.created + summary.existing;
  if (summary.failed === 0) return 200;
  if (successful > 0) return 207;
  return (summary as InternalDimensionalForkSummary)[providerFailureCount] ===
    summary.failed
    ? 502
    : 422;
}
