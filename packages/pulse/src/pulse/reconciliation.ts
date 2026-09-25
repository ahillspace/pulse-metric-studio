import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError } from '@pulse-metric-studio/core';
import {
  getPulseDefinition,
  getPulseMetric,
  listMetricsForDefinition,
  type PulseDefinition,
  type PulseExactMetric,
} from './pulse-client.js';
import { boundedProviderDiagnostic, type PulseProviderDiagnostic } from './provider-diagnostics.js';

const DEFAULT_DELAYS_MS = [0, 250, 750, 1_500, 3_000] as const;

export type MetricReconciliationStatus =
  | 'visible'
  | 'pending_visibility'
  | 'ownership_mismatch'
  | 'failed';

export interface MetricReconciliationResult {
  metricId: string;
  status: MetricReconciliationStatus;
  exactMetricResolved: boolean;
  inventoryVisible: boolean;
  ownershipVerified: boolean;
  attempts: number;
  diagnostic?: PulseProviderDiagnostic;
}

export interface MetricReconciliationDependencies {
  getMetric(session: TableauSession, metricId: string): Promise<PulseExactMetric>;
  getDefinition(session: TableauSession, definitionId: string): Promise<PulseDefinition>;
  listMetrics(session: TableauSession, definitionId: string): Promise<Array<{ id?: string; metadata?: { id?: string } }>>;
  wait(ms: number): Promise<void>;
}

const defaultDependencies: MetricReconciliationDependencies = {
  getMetric: getPulseMetric,
  getDefinition: getPulseDefinition,
  listMetrics: listMetricsForDefinition,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function reconcileMetricOwnership(
  session: TableauSession,
  expected: { metricId: string; definitionId: string; datasourceLuid: string },
  dependencies: MetricReconciliationDependencies = defaultDependencies,
  delaysMs: readonly number[] = DEFAULT_DELAYS_MS,
): Promise<MetricReconciliationResult> {
  let exactMetricResolved = false;
  let ownershipVerified = false;
  let inventoryFailure: PulseProviderDiagnostic | undefined;

  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    const delay = delaysMs[attempt] ?? 0;
    if (delay > 0) await dependencies.wait(delay);

    let metric: PulseExactMetric;
    try {
      metric = await dependencies.getMetric(session, expected.metricId);
      exactMetricResolved = true;
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      if (error instanceof TableauError && error.status === 404) continue;
      return failed(expected.metricId, attempt + 1, error, exactMetricResolved);
    }

    const actualMetricId = metricId(metric);
    if (actualMetricId && actualMetricId !== expected.metricId) {
      return mismatch(expected.metricId, attempt + 1, `Tableau returned metric ${actualMetricId} for ${expected.metricId}.`);
    }
    const actualDefinitionId = metricDefinitionId(metric);
    if (!actualDefinitionId || actualDefinitionId !== expected.definitionId) {
      return mismatch(
        expected.metricId,
        attempt + 1,
        `Metric belongs to definition ${actualDefinitionId || 'unknown'}, not ${expected.definitionId}.`,
      );
    }
    const actualSiteId = metric.site_id ?? metric.site?.id;
    if (actualSiteId && actualSiteId !== session.siteId) {
      return mismatch(expected.metricId, attempt + 1, `Metric belongs to site ${actualSiteId}, not ${session.siteId}.`);
    }

    let definition: PulseDefinition;
    try {
      definition = await dependencies.getDefinition(session, actualDefinitionId);
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      return failed(expected.metricId, attempt + 1, error, true);
    }
    const returnedDefinitionId = String(definition.metadata?.id ?? '').trim();
    if (returnedDefinitionId && returnedDefinitionId !== expected.definitionId) {
      return mismatch(
        expected.metricId,
        attempt + 1,
        `Tableau returned definition ${returnedDefinitionId} for ${expected.definitionId}.`,
      );
    }
    const datasourceLuid = definition.specification?.datasource?.id;
    if (!datasourceLuid || datasourceLuid !== expected.datasourceLuid) {
      return mismatch(
        expected.metricId,
        attempt + 1,
        `Metric definition belongs to datasource ${datasourceLuid || 'unknown'}, not ${expected.datasourceLuid}.`,
      );
    }
    ownershipVerified = true;

    try {
      const inventory = await dependencies.listMetrics(session, expected.definitionId);
      inventoryFailure = undefined;
      if (inventory.some((entry) => metricId(entry) === expected.metricId)) {
        return {
          metricId: expected.metricId,
          status: 'visible',
          exactMetricResolved: true,
          inventoryVisible: true,
          ownershipVerified: true,
          attempts: attempt + 1,
        };
      }
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      inventoryFailure = boundedProviderDiagnostic(error);
    }
  }

  if (inventoryFailure) {
    return {
      metricId: expected.metricId,
      status: 'failed',
      exactMetricResolved,
      inventoryVisible: false,
      ownershipVerified,
      attempts: delaysMs.length,
      diagnostic: inventoryFailure,
    };
  }
  return {
    metricId: expected.metricId,
    status: 'pending_visibility',
    exactMetricResolved,
    inventoryVisible: false,
    ownershipVerified,
    attempts: delaysMs.length,
  };
}

function failed(metricIdValue: string, attempts: number, error: unknown, exactMetricResolved: boolean): MetricReconciliationResult {
  return {
    metricId: metricIdValue,
    status: 'failed',
    exactMetricResolved,
    inventoryVisible: false,
    ownershipVerified: false,
    attempts,
    diagnostic: boundedProviderDiagnostic(error),
  };
}

function mismatch(metricIdValue: string, attempts: number, message: string): MetricReconciliationResult {
  return {
    metricId: metricIdValue,
    status: 'ownership_mismatch',
    exactMetricResolved: true,
    inventoryVisible: false,
    ownershipVerified: false,
    attempts,
    diagnostic: { message },
  };
}

export function metricDefinitionId(metric: PulseExactMetric): string {
  const nestedMetadata = metric.definition?.metadata;
  return String(
    metric.definition_id
    ?? metric.specification_reference?.definition_id
    ?? nestedMetadata?.id
    ?? '',
  ).trim();
}

export function metricSpecification(metric: PulseExactMetric): Record<string, unknown> | null {
  const candidate = metric.specification ?? metric.metric_specification;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function metricId(metric: { id?: string; metadata?: { id?: string } }): string {
  return String(metric.id ?? metric.metadata?.id ?? '').trim();
}
