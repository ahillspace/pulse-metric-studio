import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError, logTableauEvent, withTableauOperation } from '@pulse-metric-studio/core';
import type {
  PulseDefinitionNode,
  PulseInventoryResponse,
  PulseMetricVariant,
} from '@pulse-metric-studio/shared';
import { timeframeLabelForMeasurementPeriod } from '@pulse-metric-studio/shared';
import { boundedProviderDiagnostic } from '../pulse/provider-diagnostics.js';
import {
  type PulseDefinition,
  type PulseDefinitionInventory,
  type PulseExactMetric,
} from '../pulse/pulse-client.js';
import {
  metricDefinitionId,
  metricSpecification,
} from '../pulse/reconciliation.js';

import {
  isRecord,
  mapWithConcurrency,
  stringValue,
  touch,
} from './registry-collections.js';
import {
  defaultDependencies,
  type InventoryDependencies,
} from './registry-dependencies.js';
import { sessionCacheKey } from './session-cache-key.js';
const PROVIDER_CONCURRENCY = 5;
const DEFINITION_CACHE_TTL_MS = 15000;
const MAX_DEFINITION_CACHE_ENTRIES = 8;
export type DefinitionNode = PulseDefinitionNode;

export type MetricVariant = PulseMetricVariant;

export type InventoryFailure = PulseInventoryResponse['failures'][number];

export type ExistingMetricsResult = Omit<PulseInventoryResponse, 'snapshotId'>;

interface DefinitionCacheEntry {
  inventory: PulseDefinitionInventory;
  expiresAt: number;
}

const definitionCache = new Map<string, DefinitionCacheEntry>();
const definitionRequests = new Map<string, { promise: Promise<PulseDefinitionInventory>; fresh: boolean }>();
export async function getExistingMetrics(
  session: TableauSession,
  datasourceLuid: string,
  dependencies: InventoryDependencies = defaultDependencies,
  options: { refresh?: boolean } = {},
): Promise<ExistingMetricsResult> {
  const inventory =
    dependencies === defaultDependencies
      ? await withTableauOperation('inventory', () => cachedDefinitionInventory(session, dependencies, options))
      : await withTableauOperation('inventory', () => dependencies.listDefinitions(session));
  const failures: InventoryFailure[] = [];
  let metricsTruncated = false;
  const matching: PulseDefinition[] = [];
  for (const [index, candidate] of inventory.definitions.entries()) {
    const inventoryId = `inventory-record-${index + 1}`;
    if (!isRecord(candidate)) {
      failures.push({
        definitionId: inventoryId,
        stage: 'parse_definition',
        diagnostic: {
          message: 'Pulse definition inventory record must be an object.',
        },
      });
      continue;
    }
    const definition = candidate as PulseDefinition;
    const metadata = isRecord(definition.metadata)
      ? definition.metadata
      : undefined;
    const definitionId = stringValue(metadata?.id);
    if (!definitionId) {
      failures.push({
        definitionId: inventoryId,
        stage: 'parse_definition',
        diagnostic: {
          message:
            'Pulse definition inventory record has no definition identifier.',
        },
      });
      continue;
    }
    const specification = isRecord(definition.specification)
      ? definition.specification
      : undefined;
    const datasource = isRecord(specification?.datasource)
      ? specification.datasource
      : undefined;
    const definitionDatasourceLuid = stringValue(datasource?.id);
    if (!definitionDatasourceLuid) {
      failures.push({
        definitionId,
        stage: 'parse_definition',
        diagnostic: {
          message:
            'Pulse definition inventory record has no datasource identifier.',
        },
      });
      continue;
    }
    if (definitionDatasourceLuid === datasourceLuid) matching.push(definition);
  }

  const nodes = await mapWithConcurrency(
    matching,
    PROVIDER_CONCURRENCY,
    async (definition) => {
      const definitionId = String(definition.metadata?.id ?? '').trim();
      if (!definitionId) return null;
      let listed: Awaited<
        ReturnType<InventoryDependencies['listMetrics']>
      >;
      try {
        listed = await withTableauOperation('inventory', () => dependencies.listMetrics(session, definitionId));
      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth') throw error;
        failures.push({
          definitionId,
          stage: 'list_metrics',
          diagnostic: boundedProviderDiagnostic(error),
        });
        return definitionNode(definition, definitionId, [], 'unavailable');
      }

      const summaries = Array.isArray(listed) ? listed : listed.metrics;
      logTableauEvent({
        event: 'tableau.inventory_listing', definitionId,
        metricCount: summaries.length,
        specificationCount: summaries.filter((metric) => isRecord(metric) && isRecord(metric.specification)).length,
        metricSpecificationCount: summaries.filter((metric) => isRecord(metric) && isRecord(metric.metric_specification)).length,
        usableSpecificationCount: summaries.filter((metric) => isRecord(metric) && metricSpecification(metric)).length,
        isDefaultCount: summaries.filter((metric) => isRecord(metric) && typeof metric.is_default === 'boolean').length,
      });
      const incomplete = !Array.isArray(listed) && listed.truncated;
      if (!Array.isArray(listed) && incomplete) {
        metricsTruncated = true;
        failures.push({ definitionId, stage: 'list_metrics', diagnostic: listed.diagnostic ?? { message: 'Pulse metric inventory is incomplete.' } });
      }

      const variants = await mapWithConcurrency(
        summaries,
        PROVIDER_CONCURRENCY,
        async (summary) => {
          const summaryRecord = isRecord(summary) ? summary : undefined;
          const summaryMetadata = isRecord(summaryRecord?.metadata)
            ? summaryRecord.metadata
            : undefined;
          const metricId = stringValue(
            summaryRecord?.id ?? summaryMetadata?.id,
          );
          if (!metricId) {
            failures.push({
              definitionId,
              stage: 'parse_metric',
              diagnostic: {
                message:
                  'Pulse metric inventory record has no metric identifier.',
              },
            });
            return null;
          }
          let metric: PulseExactMetric;
          const listedMetric = summary as PulseExactMetric;
          const listedDefinitionId = metricDefinitionId(listedMetric);
          const listedSiteId = listedMetric.site_id ?? listedMetric.site?.id;
          if ((listedDefinitionId && listedDefinitionId !== definitionId) || (listedSiteId && listedSiteId !== session.siteId)) {
            failures.push({ definitionId, metricId, stage: 'parse_metric', diagnostic: { message: 'Pulse metric inventory record does not match its definition and site.' } });
            return null;
          }
          try {
            metric = listedDefinitionId && metricSpecification(listedMetric) && typeof listedMetric.is_default === 'boolean'
              ? listedMetric
              : await withTableauOperation('inventory_get_metric', () => dependencies.getMetric(session, metricId));
          } catch (error) {
            if (error instanceof TableauError && error.kind === 'auth')
              throw error;
            failures.push({
              definitionId,
              metricId,
              stage: 'get_metric',
              diagnostic: boundedProviderDiagnostic(error),
            });
            return null;
          }
          try {
            const returnedMetricId = pulseMetricId(metric);
            if (returnedMetricId && returnedMetricId !== metricId) {
              throw new Error(
                `Exact metric endpoint returned ${returnedMetricId} for ${metricId}.`,
              );
            }
            const returnedDefinitionId = metricDefinitionId(metric);
            const returnedSiteId = metric.site_id ?? metric.site?.id;
            if (returnedSiteId && returnedSiteId !== session.siteId) throw new Error('Pulse metric belongs to a different site.');
            if (
              !returnedDefinitionId ||
              returnedDefinitionId !== definitionId
            ) {
              throw new Error(
                `Exact metric ${metricId} belongs to definition ${returnedDefinitionId || 'unknown'}.`,
              );
            }
            return exactMetricVariant(
              metricId,
              summaryRecord as Parameters<typeof exactMetricVariant>[1],
              metric,
            );
          } catch (error) {
            failures.push({
              definitionId,
              metricId,
              stage: 'parse_metric',
              diagnostic: boundedProviderDiagnostic(error),
            });
            return null;
          }
        },
      );
      const metrics = variants.filter(
        (variant): variant is MetricVariant => variant !== null,
      );
      return definitionNode(
        definition,
        definitionId,
        metrics,
        !incomplete && summaries.length === metrics.length ? 'complete' : 'partial',
      );
    },
  );

  return {
    definitions: nodes.filter((node): node is DefinitionNode => node !== null),
    totalScanned: inventory.definitions.length,
    truncated: inventory.truncated || metricsTruncated,
    failures: failures.sort(compareInventoryFailures),
  };
}

function definitionNode(
  definition: PulseDefinition,
  definitionId: string,
  metrics: MetricVariant[],
  inventoryStatus: DefinitionNode['inventoryStatus'],
): DefinitionNode {
  return {
    definitionId,
    name: definition.metadata?.name ?? definitionId,
    description: definition.metadata?.description ?? '',
    measure:
      definition.specification?.basic_specification?.measure?.field ?? '?',
    aggregation: String(
      definition.specification?.basic_specification?.measure?.aggregation ?? '',
    )
      .replace(/^AGGREGATION_/, '')
      .replaceAll('_', ' '),
    timeDimension:
      definition.specification?.basic_specification?.time_dimension?.field ??
      '?',
    metrics,
    inventoryStatus,
  };
}

function exactMetricVariant(
  metricId: string,
  summary: { metadata?: { name?: string }; is_default?: boolean },
  metric: PulseExactMetric,
): MetricVariant {
  const specification = metricSpecification(metric);
  if (!specification)
    throw new Error('Exact metric response has no specification.');
  if (
    specification.filters !== undefined &&
    !Array.isArray(specification.filters)
  ) {
    throw new Error('Exact metric specification filters must be an array.');
  }
  const filters = structuredClone((specification.filters ?? []) as unknown[]);
  const measurementPeriod = structuredClone(
    specification.measurement_period ?? null,
  );
  const comparison = structuredClone(specification.comparison ?? null);
  const isDefault =
    typeof metric.is_default === 'boolean'
      ? metric.is_default
      : typeof summary.is_default === 'boolean'
        ? summary.is_default
        : null;
  const scopedState: MetricVariant['scopedState'] =
    filters.length > 0
      ? 'filtered'
      : isDefault === true
        ? 'default'
        : isDefault === false
          ? 'variant'
          : 'unknown';
  return {
    metricId,
    name: metric.metadata?.name ?? summary.metadata?.name ?? metricId,
    measurementPeriod,
    timeframeLabel: timeframeLabelForMeasurementPeriod(measurementPeriod),
    filters,
    comparison,
    isDefault,
    isScoped: filters.length > 0,
    scopedState,
    specification: structuredClone(specification),
  };
}

export async function cachedDefinitionInventory(
  session: TableauSession,
  dependencies: InventoryDependencies,
  options: { refresh?: boolean } = {},
): Promise<PulseDefinitionInventory> {
  const now = Date.now();
  const key = definitionCacheKey(session);
  const cached = definitionCache.get(key);
  if (!options.refresh && cached && cached.expiresAt > now) {
    touch(definitionCache, key, cached);
    return structuredClone(cached.inventory);
  }
  const existing = definitionRequests.get(key);
  if (existing && (!options.refresh || existing.fresh)) return structuredClone(await existing.promise);
  if (options.refresh) definitionCache.delete(key);
  const request = { promise: dependencies.listDefinitions(session), fresh: !!options.refresh };
  definitionRequests.set(key, request);
  try {
    const inventory = await request.promise;
    // A mutation may invalidate an older read while its provider request is pending.
    if (definitionRequests.get(key) === request) {
      definitionCache.set(key, {
        inventory: structuredClone(inventory),
        expiresAt: Date.now() + DEFINITION_CACHE_TTL_MS,
      });
      while (definitionCache.size > MAX_DEFINITION_CACHE_ENTRIES) {
        const oldest = definitionCache.keys().next().value as string | undefined;
        if (!oldest) break;
        definitionCache.delete(oldest);
      }
    }
    return inventory;
  } finally {
    if (definitionRequests.get(key) === request) definitionRequests.delete(key);
  }
}

export function invalidatePulseDefinitionInventory(
  session: TableauSession,
): void {
  const key = definitionCacheKey(session);
  definitionCache.delete(key);
  definitionRequests.delete(key);
}

function definitionCacheKey(session: TableauSession): string {
  return sessionCacheKey(session);
}

function pulseMetricId(metric: PulseExactMetric): string {
  return String(metric.id ?? metric.metadata?.id ?? '').trim();
}

function compareInventoryFailures(
  left: InventoryFailure,
  right: InventoryFailure,
): number {
  return (
    left.definitionId.localeCompare(right.definitionId) ||
    String(left.metricId ?? '').localeCompare(String(right.metricId ?? '')) ||
    left.stage.localeCompare(right.stage)
  );
}

export function clearInventoryCache(): void {
  definitionCache.clear();
  definitionRequests.clear();
}
