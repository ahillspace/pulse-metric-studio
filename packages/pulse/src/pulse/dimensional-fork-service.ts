import crypto from 'node:crypto';
import { getFieldCatalog, invalidateFieldsCache, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import {
  DIMENSIONAL_FORK_LIMITS,
  DIMENSION_VALUE_FETCH_CEILING,
  canonicalizeDimensionalForkRequest,
  compareCanonicalStrings,
  type DimensionMemberCount,
  type DimensionValuePage,
  type DimensionalForkRequestV1,
  type DimensionalForkResult,
  type DimensionalForkSummary,
  type FilterDimensionField,
  type CatalogField,
  type DatasourceCatalog,
} from '@pulse-metric-studio/shared';
import {
  getOrCreateDimensionalMetric,
  getPulseDefinition,
  getPulseMetric,
  queryPulseDimensionDistinctCount,
  queryPulseDimensionValues,
  type PulseDefinition,
  type PulseExactMetric,
} from './pulse-client.js';
import {
  metricDefinitionId,
  metricSpecification,
  reconcileMetricOwnership,
  type MetricReconciliationResult,
} from './reconciliation.js';
import { boundedProviderDiagnostic, diagnosticMessage } from './provider-diagnostics.js';

const PROVIDER_CONCURRENCY = 5;
/**
 * Fetch-all bounded row limit. One more than the fetch-all/search-required
 * threshold so a domain of exactly the threshold size is returned complete,
 * while anything larger reports `truncated`.
 */
const FETCH_ALL_ROW_LIMIT = DIMENSIONAL_FORK_LIMITS.valueModeThreshold + 1;
const providerFailureCount = Symbol('providerFailureCount');

export class PulseDimensionalForkError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 409 | 422 | 502 = 422) {
    super(message);
    this.name = 'PulseDimensionalForkError';
  }
}

export interface PulseDimensionalForkDependencies {
  getMetric(session: TableauSession, metricId: string): Promise<PulseExactMetric>;
  getDefinition(session: TableauSession, definitionId: string): Promise<PulseDefinition>;
  getCatalog(session: TableauSession, datasourceLuid: string): Promise<DatasourceCatalog>;
  queryValues(
    session: TableauSession,
    input: {
      datasourceLuid: string;
      fieldName: string;
      rowLimit: number;
      contains?: string;
      matchValues?: string[];
    },
  ): Promise<unknown[]>;
  queryCount(
    session: TableauSession,
    input: { datasourceLuid: string; fieldName: string },
  ): Promise<number>;
  getOrCreate(
    session: TableauSession,
    input: { definitionId: string; specification: Record<string, unknown> },
  ): Promise<{ metricId: string | null; metricApiName?: string; created: boolean }>;
  reconcile(
    session: TableauSession,
    input: { metricId: string; definitionId: string; datasourceLuid: string },
  ): Promise<MetricReconciliationResult>;
}

const defaultDependencies: PulseDimensionalForkDependencies = {
  getMetric: getPulseMetric,
  getDefinition: getPulseDefinition,
  getCatalog: async (session, datasourceLuid) => {
    const catalog = await getFieldCatalog(session, datasourceLuid);
    if (catalog.source !== 'cache') return catalog;
    invalidateFieldsCache(datasourceLuid);
    return getFieldCatalog(session, datasourceLuid);
  },
  queryValues: queryPulseDimensionValues,
  queryCount: queryPulseDimensionDistinctCount,
  getOrCreate: getOrCreateDimensionalMetric,
  reconcile: reconcileMetricOwnership,
};

interface ResolvedSource {
  metricId: string;
  definitionId: string;
  datasourceLuid: string;
  allowedDimensions: Set<string>;
  specification: Record<string, unknown>;
}

interface ResolvedContext {
  sources: ResolvedSource[];
  datasourceLuid: string;
  fields: FilterDimensionField[];
  fieldsById: Map<string, FilterDimensionField>;
}

type InternalDimensionalForkSummary = DimensionalForkSummary & {
  [providerFailureCount]?: number;
};

export class PulseDimensionalForkService {
  constructor(
    private readonly dependencies: PulseDimensionalForkDependencies = defaultDependencies,
  ) {}

  async listEligibleDimensions(
    session: TableauSession,
    sourceMetricIds: string[],
  ): Promise<{ fields: FilterDimensionField[] }> {
    const context = await this.resolveContext(session, validateSourceMetricIds(sourceMetricIds));
    return { fields: context.fields };
  }

  /**
   * Return the total distinct-member count for a field, used by the client to
   * choose between fetch-all and search-required value selection.
   */
  async countDimensionMembers(
    session: TableauSession,
    input: { sourceMetricIds: string[]; fieldId: string },
  ): Promise<DimensionMemberCount> {
    const sourceMetricIds = validateSourceMetricIds(input.sourceMetricIds);
    const fieldId = String(input.fieldId ?? '').trim();
    if (!fieldId) throw new PulseDimensionalForkError('fieldId is required.', 400);
    const context = await this.resolveContext(session, sourceMetricIds);
    const field = context.fieldsById.get(fieldId);
    if (!field) throw new PulseDimensionalForkError('The selected field is not eligible for every source metric.', 422);
    const count = await this.dependencies.queryCount(session, {
      datasourceLuid: context.datasourceLuid,
      fieldName: field.name,
    });
    return { fieldId, count };
  }

  /**
   * List selectable values for a field in a single bounded query. Each call is
   * self-contained; there is no stateful pagination.
   *   - default (no `search`, no `all`): auto-load path - the entire domain up
   *     to {@link FETCH_ALL_ROW_LIMIT}, so a domain larger than the auto-load
   *     threshold reports `truncated` and the picker asks the user to search or
   *     Load all.
   *   - `search`: a server-side substring query, bounded only by
   *     {@link DIMENSION_VALUE_FETCH_CEILING} (every match is returned).
   *   - `all`: Load all - the entire domain, bounded only by the ceiling.
   */
  async listDimensionValues(
    session: TableauSession,
    input: { sourceMetricIds: string[]; fieldId: string; search?: string; all?: boolean },
  ): Promise<DimensionValuePage> {
    const sourceMetricIds = validateSourceMetricIds(input.sourceMetricIds);
    const fieldId = String(input.fieldId ?? '').trim();
    if (!fieldId) throw new PulseDimensionalForkError('fieldId is required.', 400);
    const search = String(input.search ?? '').trim();
    if (search.length > DIMENSIONAL_FORK_LIMITS.valueCharacters) {
      throw new PulseDimensionalForkError(`search must be at most ${DIMENSIONAL_FORK_LIMITS.valueCharacters} characters.`, 400);
    }

    const context = await this.resolveContext(session, sourceMetricIds);
    const field = context.fieldsById.get(fieldId);
    if (!field) throw new PulseDimensionalForkError('The selected field is not eligible for every source metric.', 422);

    const rowLimit = search || input.all ? DIMENSION_VALUE_FETCH_CEILING : FETCH_ALL_ROW_LIMIT;
    const rows = await this.dependencies.queryValues(session, {
      datasourceLuid: context.datasourceLuid,
      fieldName: field.name,
      rowLimit,
      ...(search ? { contains: search } : {}),
    });
    const normalized = normalizeDistinctStringValues(rows);
    const truncated = rows.length >= rowLimit || normalized.hadUnsupportedValue;
    return {
      fieldId,
      values: normalized.values.map((value) => ({ key: value, label: value, value })),
      truncated,
    };
  }

  async forkMetrics(session: TableauSession, input: unknown): Promise<DimensionalForkSummary> {
    let request: DimensionalForkRequestV1;
    try {
      request = canonicalizeDimensionalForkRequest(input);
    } catch (error) {
      throw new PulseDimensionalForkError(error instanceof Error ? error.message : 'Invalid dimensional fork request.', 400);
    }
    const context = await this.resolveContext(session, request.sourceMetricIds);
    const field = context.fieldsById.get(request.fieldId);
    if (!field) throw new PulseDimensionalForkError('The selected field is not eligible for every source metric.', 422);
    await this.assertSelectedValuesExist(session, context.datasourceLuid, field, request.selection.values);
    const valueFingerprint = fingerprintValues(request.selection.values);

    const results: DimensionalForkResult[] = [];
    let providerFailures = 0;
    let terminated = false;
    for (let index = 0; index < context.sources.length; index += PROVIDER_CONCURRENCY) {
      const batch = context.sources.slice(index, index + PROVIDER_CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (source) => {
        const base = { sourceMetricId: source.metricId, fieldId: field.id, valueFingerprint };
        if (terminated) return { result: { ...base, status: 'failed' as const, creationStatus: 'not_attempted' as const, error: 'Not sent because the Tableau session ended. Reconnect before retrying.' }, providerFailure: false };
        let specification: Record<string, unknown>;
        try {
          specification = mergePulseStringFilter(source.specification, field.name, request.selection.values, request.selection.exclude);
        } catch (error) {
          const diagnostic = boundedProviderDiagnostic(error);
          return {
            result: {
              ...base,
              status: 'failed' as const,
              error: diagnosticMessage(diagnostic),
              diagnostic,
            },
            providerFailure: false,
          };
        }
        let response: { metricId: string | null; created: boolean; metricApiName?: string } | undefined;
        try {
          response = await this.dependencies.getOrCreate(session, {
            definitionId: source.definitionId,
            specification,
          });
          if (!response.metricId) {
            return {
              result: { ...base, status: 'failed' as const, creationStatus: 'unknown' as const, error: 'Tableau returned no metric identifier; creation outcome is unknown.' },
              providerFailure: true,
            };
          }
          const reconciliation = await this.dependencies.reconcile(session, {
            metricId: response.metricId,
            definitionId: source.definitionId,
            datasourceLuid: source.datasourceLuid,
          });
          const reconciliationFailed = reconciliation.status === 'ownership_mismatch'
            || reconciliation.status === 'failed';
          return {
            result: {
              ...base,
              status: reconciliationFailed
                ? 'failed' as const
                : response.created ? 'created' as const : 'existing' as const,
              creationStatus: response.created ? 'created' as const : 'existing' as const,
              createdMetricId: response.metricId,
              ...(response.metricApiName ? { createdApiName: response.metricApiName } : {}),
              requestedSpecification: specification,
              reconciliationStatus: reconciliation.status,
              exactMetricResolved: reconciliation.exactMetricResolved,
              inventoryVisible: reconciliation.inventoryVisible,
              ownershipVerified: reconciliation.ownershipVerified,
              ...(reconciliation.diagnostic ? { diagnostic: reconciliation.diagnostic } : {}),
              ...(reconciliationFailed
                ? { error: reconciliation.diagnostic
                  ? diagnosticMessage(reconciliation.diagnostic)
                  : 'Metric reconciliation failed.' }
                : {}),
            },
            providerFailure: reconciliation.status === 'failed',
          };
        } catch (error) {
          if (error instanceof TableauError && error.kind === 'auth') terminated = true;
          const diagnostic = boundedProviderDiagnostic(error);
          return {
            result: {
              ...base,
              status: 'failed' as const,
              creationStatus: response?.metricId ? response.created ? 'created' as const : 'existing' as const : 'unknown' as const,
              ...(response?.metricId ? { createdMetricId: response.metricId, reconciliationStatus: 'failed' as const } : {}),
              requestedSpecification: specification,
              error: diagnosticMessage(diagnostic),
              diagnostic,
            },
            providerFailure: true,
          };
        }
      }));
      results.push(...outcomes.map((outcome) => outcome.result));
      providerFailures += outcomes.filter((outcome) => outcome.providerFailure).length;
    }
    const summary = summarize(results) as InternalDimensionalForkSummary;
    if (terminated) summary.terminated = true;
    Object.defineProperty(summary, providerFailureCount, { value: providerFailures, enumerable: false });
    return summary;
  }

  /**
   * Confirm every selected value still exists in the provider domain with a
   * single targeted set-filter query. This is bounded by the selected-value
   * count (not the domain size), so it validates values from search-required
   * dimensions that lie beyond the fetch-all cap.
   */
  private async assertSelectedValuesExist(
    session: TableauSession,
    datasourceLuid: string,
    field: FilterDimensionField,
    values: string[],
  ): Promise<void> {
    const rows = await this.dependencies.queryValues(session, {
      datasourceLuid,
      fieldName: field.name,
      rowLimit: values.length,
      matchValues: values,
    });
    const present = new Set(normalizeDistinctStringValues(rows).values);
    if (values.some((value) => !present.has(value))) {
      throw new PulseDimensionalForkError(
        'One or more selected values are not present in the current provider domain.',
        422,
      );
    }
  }

  private async resolveContext(session: TableauSession, sourceMetricIds: string[]): Promise<ResolvedContext> {
    const metrics = await Promise.all(sourceMetricIds.map(async (metricId) => ({
      metricId,
      metric: await this.dependencies.getMetric(session, metricId),
    })));
    const definitionPromises = new Map<string, Promise<PulseDefinition>>();
    const partial = metrics.map(({ metricId, metric }) => {
      const returnedMetricId = String(metric.id ?? metric.metadata?.id ?? '').trim();
      if (returnedMetricId && returnedMetricId !== metricId) {
        throw new PulseDimensionalForkError(`Exact metric endpoint returned ${returnedMetricId} for ${metricId}.`, 409);
      }
      const sourceSiteId = metric.site_id ?? metric.site?.id;
      if (sourceSiteId && sourceSiteId !== session.siteId) {
        throw new PulseDimensionalForkError(`Source metric ${metricId} belongs to a different site.`, 409);
      }
      const definitionId = metricDefinitionId(metric);
      const specification = metricSpecification(metric);
      if (!definitionId) throw new PulseDimensionalForkError(`Source metric ${metricId} has no definition identifier.`, 409);
      if (!specification) throw new PulseDimensionalForkError(`Source metric ${metricId} has no exact specification.`, 409);
      if (!definitionPromises.has(definitionId)) {
        definitionPromises.set(definitionId, this.dependencies.getDefinition(session, definitionId));
      }
      return { metricId, definitionId, specification };
    });
    const sources = await Promise.all(partial.map(async (source): Promise<ResolvedSource> => {
      const definition = await definitionPromises.get(source.definitionId)!;
      const returnedDefinitionId = String(definition.metadata?.id ?? '').trim();
      if (returnedDefinitionId && returnedDefinitionId !== source.definitionId) {
        throw new PulseDimensionalForkError(
          `Tableau returned definition ${returnedDefinitionId} for ${source.definitionId}.`,
          409,
        );
      }
      const datasourceLuid = definition.specification?.datasource?.id;
      const allowedDimensions = definition.extension_options?.allowed_dimensions;
      if (!datasourceLuid) {
        throw new PulseDimensionalForkError(`Definition ${source.definitionId} has no datasource identifier.`, 409);
      }
      if (!Array.isArray(allowedDimensions)) {
        throw new PulseDimensionalForkError(`Definition ${source.definitionId} has no allowed_dimensions catalog.`, 409);
      }
      return {
        ...source,
        datasourceLuid,
        allowedDimensions: new Set(allowedDimensions.filter((value): value is string => typeof value === 'string')),
      };
    }));
    const datasourceLuid = sources[0]!.datasourceLuid;
    if (sources.some((source) => source.datasourceLuid !== datasourceLuid)) {
      throw new PulseDimensionalForkError('Selected source metrics must use the same datasource.', 422);
    }
    const catalog = await this.dependencies.getCatalog(session, datasourceLuid);
    if (catalog.source !== 'vds') {
      throw new PulseDimensionalForkError('Pulse dimensional filters require a current VDS field catalog.', 422);
    }
    const fields = intersectEligibleFields(catalog.dimensions, sources);
    return { sources, datasourceLuid, fields, fieldsById: new Map(fields.map((field) => [field.id, field])) };
  }
}

export function mergePulseStringFilter(
  sourceSpecification: Record<string, unknown>,
  fieldName: string,
  values: string[],
  exclude = false,
): Record<string, unknown> {
  const specification = structuredClone(sourceSpecification);
  delete specification.datasource;
  if (specification.filters !== undefined && !Array.isArray(specification.filters)) {
    throw new PulseDimensionalForkError('Source metric filters must be an array.', 422);
  }
  const filters = specification.filters ?? [];
  const matchingIndexes = filters.flatMap((filter, index) => (
    filter && typeof filter === 'object' && (filter as Record<string, unknown>).field === fieldName ? [index] : []
  ));
  if (matchingIndexes.length > 1) {
    throw new PulseDimensionalForkError(`Source metric has multiple filters on ${fieldName}.`, 422);
  }
  const canonicalValues = [...new Set(values)].sort(compareCanonicalStrings);
  // Exclude emits OPERATOR_NOT_EQUAL (documented in the Pulse OpenAPI); include
  // keeps the proven OPERATOR_EQUAL. include_null stays false either way, which
  // matches Pulse's "All" behavior of dropping null members from the domain.
  const replacement = {
    field: fieldName,
    operator: exclude ? 'OPERATOR_NOT_EQUAL' : 'OPERATOR_EQUAL',
    categorical_values: canonicalValues.map((value) => ({ string_value: value })),
    include_null: false,
  };
  if (matchingIndexes.length === 1) filters[matchingIndexes[0]!] = replacement;
  else filters.push(replacement);
  specification.filters = filters;
  return specification;
}

export function fingerprintValues(values: string[]): string {
  const canonical = [...new Set(values)].sort(compareCanonicalStrings);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 24);
}

function validateSourceMetricIds(values: string[]): string[] {
  if (!Array.isArray(values)) throw new PulseDimensionalForkError('sourceMetricId is required.', 400);
  const normalized = [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (normalized.length === 0) throw new PulseDimensionalForkError('At least one sourceMetricId is required.', 400);
  return normalized.sort(compareCanonicalStrings);
}

function intersectEligibleFields(fields: CatalogField[], sources: ResolvedSource[]): FilterDimensionField[] {
  const nameCounts = new Map<string, number>();
  for (const field of fields) nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1);
  return fields
    .filter((field) => field.role === 'DIMENSION' && field.dataType.toUpperCase() === 'STRING')
    .filter((field) => nameCounts.get(field.name) === 1)
    .filter((field) => sources.every((source) => source.allowedDimensions.has(field.name)))
    .map((field) => ({
      id: field.id,
      name: field.name,
      label: field.label,
      ...(field.table ? { table: field.table } : {}),
      role: 'dimension' as const,
      dataType: 'string' as const,
      providerReference: { fieldName: field.name },
    }))
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
}

function normalizeDistinctStringValues(rows: unknown[]): { values: string[]; hadUnsupportedValue: boolean } {
  const values: string[] = [];
  const seen = new Set<string>();
  let hadUnsupportedValue = false;
  for (const row of rows) {
    const value = Array.isArray(row)
      ? row[0]
      : row && typeof row === 'object'
        ? Object.values(row as Record<string, unknown>)[0]
        : row;
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    if (Array.from(value).length > DIMENSIONAL_FORK_LIMITS.valueCharacters) {
      hadUnsupportedValue = true;
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return { values: values.sort(compareCanonicalStrings), hadUnsupportedValue };
}

function rethrowAuth(error: unknown): void {
  if (error instanceof TableauError && error.kind === 'auth') {
    (error as TableauError & { statusCode?: number }).statusCode = 401;
    throw error;
  }
}

function summarize(results: DimensionalForkResult[]): DimensionalForkSummary {
  return {
    attempted: results.length,
    notAttempted: results.filter((result) => result.creationStatus === 'not_attempted').length,
    created: results.filter((result) => result.creationStatus === 'created' || result.status === 'created').length,
    existing: results.filter((result) => result.creationStatus === 'existing' || result.status === 'existing').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  };
}

export function dimensionalForkHttpStatus(summary: DimensionalForkSummary): 200 | 207 | 422 | 502 {
  const successful = summary.created + summary.existing;
  if (summary.failed === 0) return 200;
  if (successful > 0) return 207;
  return (summary as InternalDimensionalForkSummary)[providerFailureCount] === summary.failed ? 502 : 422;
}

export const pulseDimensionalForkService = new PulseDimensionalForkService();
