import type { TableauSession } from '@pulse-metric-studio/core';
import { getFieldCatalog, invalidateFieldsCache, TableauError } from '@pulse-metric-studio/core';
import {
  DIMENSIONAL_FORK_LIMITS,
  compareCanonicalStrings,
  resolveTimeframe,
  type CatalogField,
  type DatasourceCatalog,
} from '@pulse-metric-studio/shared';
import { mergePulseStringFilter } from './dimensional-fork-service.js';
import { timeframeMeasurementPeriod } from './manage-service.js';
import {
  getOrCreatePulseMetric,
  getPulseDefinition,
  getPulseMetric,
  queryPulseDimensionValues,
  type PulseDefinition,
  type PulseExactMetric,
} from './pulse-client.js';
import { boundedProviderDiagnostic, diagnosticMessage } from './provider-diagnostics.js';
import {
  metricDefinitionId,
  metricSpecification,
  reconcileMetricOwnership,
  type MetricReconciliationResult,
} from './reconciliation.js';

const PROVIDER_CONCURRENCY = 5;
const providerFailureCount = Symbol('providerFailureCount');

export type PulseForkPlanStatus =
  | 'created'
  | 'existing'
  | 'failed'
  | 'pending_visibility'
  | 'visible'
  | 'ownership_mismatch';

export interface PulseForkPlanRequestV1 {
  version: 1;
  sourceMetricIds: string[];
  timeframe?: {
    key: string;
    customDays?: number;
  };
  clauses: Array<{
    fieldId: string;
    selection: {
      mode: 'VALUES';
      exclude: boolean;
      values: string[];
    };
  }>;
}

export interface PulseForkPlanResult {
  sourceMetricId: string;
  status: PulseForkPlanStatus;
  creationStatus?: 'created' | 'existing' | 'unknown' | 'not_attempted';
  reconciliationStatus?: MetricReconciliationResult['status'];
  metricId?: string;
  requestedSpecification: Record<string, unknown>;
  error?: string;
}

export interface PulseForkPlanSummary {
  terminated?: boolean;
  notAttempted?: number;
  attempted: number;
  created: number;
  existing: number;
  failed: number;
  pendingVisibility: number;
  results: PulseForkPlanResult[];
}

type InternalPulseForkPlanSummary = PulseForkPlanSummary & {
  [providerFailureCount]?: number;
};

export interface PulseForkPlanDependencies {
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
  getOrCreate(
    session: TableauSession,
    input: { definitionId: string; specification: Record<string, unknown> },
  ): Promise<{ metricId: string | null; created: boolean }>;
  reconcile(
    session: TableauSession,
    input: { metricId: string; definitionId: string; datasourceLuid: string },
  ): Promise<MetricReconciliationResult>;
}

const defaultDependencies: PulseForkPlanDependencies = {
  getMetric: getPulseMetric,
  getDefinition: getPulseDefinition,
  getCatalog: async (session, datasourceLuid) => {
    const catalog = await getFieldCatalog(session, datasourceLuid);
    if (catalog.source !== 'cache') return catalog;
    invalidateFieldsCache(datasourceLuid);
    return getFieldCatalog(session, datasourceLuid);
  },
  queryValues: queryPulseDimensionValues,
  getOrCreate: getOrCreatePulseMetric,
  reconcile: reconcileMetricOwnership,
};

interface ResolvedSource {
  metricId: string;
  definitionId: string;
  datasourceLuid: string;
  allowedDimensions: Set<string>;
  specification: Record<string, unknown>;
}

interface ResolvedClause {
  fieldId: string;
  fieldName: string;
  exclude: boolean;
  values: string[];
}

interface FailedResult {
  result: PulseForkPlanResult;
  providerFailure: boolean;
}

export class PulseForkPlanError extends Error {
  constructor(message: string, public readonly statusCode: 400 = 400) {
    super(message);
    this.name = 'PulseForkPlanError';
  }
}

export class PulseForkPlanService {
  constructor(private readonly dependencies: PulseForkPlanDependencies = defaultDependencies) {}

  async forkMetrics(session: TableauSession, input: unknown): Promise<PulseForkPlanSummary> {
    const request = canonicalizeForkPlanRequest(input);
    const requiresAllowedDimensions = request.clauses.length > 0;
    const definitionPromises = new Map<string, Promise<PulseDefinition>>();
    const resolved: ResolvedSource[] = [];
    const failures: FailedResult[] = [];

    const sourceOutcomes = await mapWithConcurrency(
      request.sourceMetricIds,
      PROVIDER_CONCURRENCY,
      async (sourceMetricId): Promise<ResolvedSource | FailedResult> => {
        try {
          return await this.resolveSource(
            session,
            sourceMetricId,
            definitionPromises,
            requiresAllowedDimensions,
          );
        } catch (error) {
          rethrowAuth(error);
          return failedResult(sourceMetricId, error, error instanceof TableauError);
        }
      },
    );
    for (const outcome of sourceOutcomes) {
      if ('result' in outcome) failures.push(outcome);
      else resolved.push(outcome);
    }

    if (resolved.length === 0) return summarize(failures);

    const datasourceLuids = [...new Set(resolved.map((source) => source.datasourceLuid))];
    if (datasourceLuids.length !== 1) {
      const error = new Error('Selected source metrics must use the same datasource.');
      failures.push(...resolved.map((source) => failedResult(source.metricId, error, false)));
      return summarize(failures);
    }

    let clauses: ResolvedClause[];
    try {
      clauses = await this.resolveClauses(session, datasourceLuids[0]!, resolved, request);
    } catch (error) {
      rethrowAuth(error);
      const providerFailure = error instanceof TableauError;
      failures.push(...resolved.map((source) => failedResult(source.metricId, error, providerFailure)));
      return summarize(failures);
    }

    const measurementPeriod = request.timeframe
      ? timeframeMeasurementPeriod(resolveTimeframe(request.timeframe.key, request.timeframe.customDays)!)
      : undefined;
    const plans = new Map<string, { source: ResolvedSource; specification: Record<string, unknown> }>();
    for (const source of resolved) {
      try {
        let specification = structuredClone(source.specification);
        delete specification.datasource;
        if (measurementPeriod) specification.measurement_period = structuredClone(measurementPeriod);
        for (const clause of clauses) {
          specification = mergePulseStringFilter(specification, clause.fieldName, clause.values, clause.exclude);
        }
        const key = `${source.metricId}\u0000${stableJson(specification)}`;
        if (!plans.has(key)) plans.set(key, { source, specification });
      } catch (error) {
        failures.push(failedResult(source.metricId, error, false));
      }
    }

    const mutationControl = {
      stopped: false,
      notStarted: ({ source, specification }: { source: ResolvedSource; specification: Record<string, unknown> }): FailedResult =>
        failedResult(source.metricId, new Error('Not sent because the Tableau session ended. Reconnect before retrying.'), false, specification, undefined, 'failed', { creationStatus: 'not_attempted' }),
    };
    const created = await mapWithConcurrency(
      [...plans.values()],
      PROVIDER_CONCURRENCY,
      async ({ source, specification }): Promise<PulseForkPlanResult | FailedResult> => {
        let response: { metricId: string | null; created: boolean } | undefined;
        try {
          response = await this.dependencies.getOrCreate(session, {
            definitionId: source.definitionId,
            specification,
          });
          if (!response.metricId) {
            return failedResult(source.metricId, new Error('Tableau returned no metric identifier; creation outcome is unknown.'), true, specification, undefined, 'failed', { creationStatus: 'unknown' });
          }
          const reconciliation = await this.dependencies.reconcile(session, {
            metricId: response.metricId,
            definitionId: source.definitionId,
            datasourceLuid: source.datasourceLuid,
          });
          return reconciledResult(source.metricId, response.metricId, response.created, specification, reconciliation);
        } catch (error) {
          if (error instanceof TableauError && error.kind === 'auth') mutationControl.stopped = true;
          return failedResult(source.metricId, error, true, specification, response?.metricId ?? undefined, 'failed', {
            creationStatus: response?.metricId ? response.created ? 'created' : 'existing' : 'unknown',
            ...(response?.metricId ? { reconciliationStatus: 'failed' } : {}),
          });
        }
      },
      mutationControl,
    );

    const results: PulseForkPlanResult[] = failures.map((failure) => failure.result);
    let providerFailures = failures.filter((failure) => failure.providerFailure).length;
    for (const outcome of created) {
      if ('result' in outcome) {
        results.push(outcome.result);
        if (outcome.providerFailure) providerFailures++;
      } else {
        results.push(outcome);
      }
    }
    const summary = summarizeResults(results, providerFailures);
    if (mutationControl.stopped) summary.terminated = true;
    return summary;
  }

  private async resolveSource(
    session: TableauSession,
    sourceMetricId: string,
    definitionPromises: Map<string, Promise<PulseDefinition>>,
    requiresAllowedDimensions: boolean,
  ): Promise<ResolvedSource> {
    const metric = await this.dependencies.getMetric(session, sourceMetricId);
    const returnedMetricId = String(metric.id ?? metric.metadata?.id ?? '').trim();
    if (returnedMetricId && returnedMetricId !== sourceMetricId) {
      throw new Error(`Exact metric endpoint returned ${returnedMetricId} for ${sourceMetricId}.`);
    }
    const sourceSiteId = metric.site_id ?? metric.site?.id;
    if (sourceSiteId && sourceSiteId !== session.siteId) {
      throw new Error(`Exact source metric belongs to site ${sourceSiteId}, not ${session.siteId}.`);
    }
    const definitionId = metricDefinitionId(metric);
    const specification = metricSpecification(metric);
    if (!definitionId) throw new Error('Exact source metric has no definition identifier.');
    if (!specification) throw new Error('Exact source metric has no specification.');

    let definitionPromise = definitionPromises.get(definitionId);
    if (!definitionPromise) {
      definitionPromise = this.dependencies.getDefinition(session, definitionId);
      definitionPromises.set(definitionId, definitionPromise);
    }
    const definition = await definitionPromise;
    const returnedDefinitionId = String(definition.metadata?.id ?? '').trim();
    if (returnedDefinitionId && returnedDefinitionId !== definitionId) {
      throw new Error(`Tableau returned definition ${returnedDefinitionId} for ${definitionId}.`);
    }
    const datasourceLuid = String(definition.specification?.datasource?.id ?? '').trim();
    if (!datasourceLuid) throw new Error(`Definition ${definitionId} has no datasource identifier.`);
    const allowedDimensions = definition.extension_options?.allowed_dimensions;
    if (requiresAllowedDimensions && !Array.isArray(allowedDimensions)) {
      throw new Error(`Definition ${definitionId} has no allowed_dimensions catalog.`);
    }
    return {
      metricId: sourceMetricId,
      definitionId,
      datasourceLuid,
      allowedDimensions: new Set(
        Array.isArray(allowedDimensions)
          ? allowedDimensions.filter((value): value is string => typeof value === 'string')
          : [],
      ),
      specification,
    };
  }

  private async resolveClauses(
    session: TableauSession,
    datasourceLuid: string,
    sources: ResolvedSource[],
    request: PulseForkPlanRequestV1,
  ): Promise<ResolvedClause[]> {
    if (request.clauses.length === 0) return [];
    const catalog = await this.dependencies.getCatalog(session, datasourceLuid);
    if (catalog.source !== 'vds') {
      throw new Error('Pulse dimensional filters require a current VDS field catalog.');
    }
    const fieldsById = eligibleFieldsById(catalog.dimensions, sources);
    const clauses = request.clauses.map((clause): ResolvedClause => {
      const field = fieldsById.get(clause.fieldId);
      if (!field) throw new Error(`Field ${clause.fieldId} is not eligible for every source metric.`);
      return { fieldId: clause.fieldId, fieldName: field.name, exclude: clause.selection.exclude, values: clause.selection.values };
    });

    await mapWithConcurrency(clauses, PROVIDER_CONCURRENCY, async (clause) => {
      if (clause.values.length === 0) return;
      // Validate the selected values with a targeted set-filter query bounded by
      // the selection size, not the domain size. This confirms values from
      // large (search-required) dimensions that lie beyond any bounded listing.
      const rows = await this.dependencies.queryValues(session, {
        datasourceLuid,
        fieldName: clause.fieldName,
        rowLimit: clause.values.length,
        matchValues: clause.values,
      });
      const present = normalizedDomain(rows);
      if (clause.values.some((value) => !present.has(value))) {
        throw new Error(`One or more selected values are not in the current domain for field ${clause.fieldId}.`);
      }
    });
    return clauses;
  }
}

export function canonicalizeForkPlanRequest(input: unknown): PulseForkPlanRequestV1 {
  if (!isRecord(input)) throw invalidRequest('Request body must be an object.');
  if (input.version !== 1) throw invalidRequest('version must equal 1.');
  if (!Array.isArray(input.sourceMetricIds)) throw invalidRequest('sourceMetricIds must be an array.');
  const sourceMetricIds = canonicalIdentifiers(input.sourceMetricIds, 'sourceMetricIds');
  if (sourceMetricIds.length === 0) throw invalidRequest('At least one sourceMetricId is required.');
  if (!Array.isArray(input.clauses)) throw invalidRequest('clauses must be an array.');

  const clausesByField = new Map<string, { values: Set<string>; exclude: boolean }>();
  for (const [index, candidate] of input.clauses.entries()) {
    if (!isRecord(candidate)) throw invalidRequest(`clauses[${index}] must be an object.`);
    const fieldId = identifier(candidate.fieldId, `clauses[${index}].fieldId`);
    if (!isRecord(candidate.selection) || candidate.selection.mode !== 'VALUES') {
      throw invalidRequest(`clauses[${index}].selection.mode must equal VALUES.`);
    }
    if (!Array.isArray(candidate.selection.values) || candidate.selection.values.length === 0) {
      throw invalidRequest(`clauses[${index}].selection.values must be a non-empty array.`);
    }
    const exclude = clauseExclude(candidate.selection.exclude, `clauses[${index}].selection.exclude`);
    const values = selectedValues(candidate.selection.values, `clauses[${index}].selection.values`);
    let merged = clausesByField.get(fieldId);
    if (!merged) {
      merged = { values: new Set<string>(), exclude };
      clausesByField.set(fieldId, merged);
    } else if (merged.exclude !== exclude) {
      // A field is either an include or an exclude filter, never both at once.
      throw invalidRequest(`clauses[${index}] mixes include and exclude for field ${fieldId}.`);
    }
    for (const value of values) merged.values.add(value);
  }

  let timeframe: PulseForkPlanRequestV1['timeframe'];
  if (input.timeframe !== undefined) {
    if (!isRecord(input.timeframe)) throw invalidRequest('timeframe must be an object.');
    const key = identifier(input.timeframe.key, 'timeframe.key');
    const customDays = input.timeframe.customDays;
    if (key !== 'CUSTOM_N_DAYS' && customDays !== undefined) {
      throw invalidRequest('customDays is supported only for CUSTOM_N_DAYS.');
    }
    if (!resolveTimeframe(key, typeof customDays === 'number' ? customDays : undefined)) {
      throw invalidRequest(`Unknown or invalid timeframe ${key}.`);
    }
    timeframe = {
      key,
      ...(customDays !== undefined ? { customDays: customDays as number } : {}),
    };
  }
  if (!timeframe && clausesByField.size === 0) {
    throw invalidRequest('A timeframe or at least one dimensional clause is required.');
  }

  return {
    version: 1,
    sourceMetricIds,
    ...(timeframe ? { timeframe } : {}),
    clauses: [...clausesByField.entries()]
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([fieldId, { values, exclude }]) => ({
        fieldId,
        selection: { mode: 'VALUES' as const, exclude, values: [...values].sort(compareCanonicalStrings) },
      })),
  };
}

export function forkPlanHttpStatus(summary: PulseForkPlanSummary): 200 | 207 | 422 | 502 {
  if (summary.failed === 0) return 200;
  if (summary.created + summary.existing > 0) return 207;
  if (summary.failed < summary.attempted) return 207;
  return (summary as InternalPulseForkPlanSummary)[providerFailureCount] === summary.failed ? 502 : 422;
}

export const pulseForkPlanService = new PulseForkPlanService();

function eligibleFieldsById(fields: CatalogField[], sources: ResolvedSource[]): Map<string, CatalogField> {
  const nameCounts = new Map<string, number>();
  for (const field of fields) nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1);
  return new Map(fields
    .filter((field) => field.role === 'DIMENSION' && field.dataType.toUpperCase() === 'STRING')
    .filter((field) => nameCounts.get(field.name) === 1)
    .filter((field) => sources.every((source) => source.allowedDimensions.has(field.name)))
    .map((field) => [field.id, field]));
}

function reconciledResult(
  sourceMetricId: string,
  metricId: string,
  created: boolean,
  requestedSpecification: Record<string, unknown>,
  reconciliation: MetricReconciliationResult,
): PulseForkPlanResult | FailedResult {
  const creationStatus = created ? 'created' as const : 'existing' as const;
  const resultContext = {
    creationStatus,
    reconciliationStatus: reconciliation.status,
  };
  if (reconciliation.status === 'ownership_mismatch') {
    return failedResult(
      sourceMetricId,
      new Error(reconciliation.diagnostic?.message ?? 'Metric ownership does not match the requested source.'),
      false,
      requestedSpecification,
      metricId,
      'ownership_mismatch',
      resultContext,
    );
  }
  if (reconciliation.status === 'failed') {
    return failedResult(
      sourceMetricId,
      new Error(reconciliation.diagnostic ? diagnosticMessage(reconciliation.diagnostic) : 'Metric reconciliation failed.'),
      true,
      requestedSpecification,
      metricId,
      'failed',
      resultContext,
    );
  }
  return {
    sourceMetricId,
    status: reconciliation.status,
    ...resultContext,
    metricId,
    requestedSpecification,
  };
}

function failedResult(
  sourceMetricId: string,
  error: unknown,
  providerFailure: boolean,
  requestedSpecification: Record<string, unknown> = {},
  metricId?: string,
  status: 'failed' | 'ownership_mismatch' = 'failed',
  context: Pick<PulseForkPlanResult, 'creationStatus' | 'reconciliationStatus'> = {},
): FailedResult {
  const diagnostic = boundedProviderDiagnostic(error);
  return {
    result: {
      sourceMetricId,
      status,
      ...context,
      ...(metricId ? { metricId } : {}),
      requestedSpecification,
      error: diagnosticMessage(diagnostic),
    },
    providerFailure,
  };
}

function summarize(failures: FailedResult[]): PulseForkPlanSummary {
  return summarizeResults(
    failures.map((failure) => failure.result),
    failures.filter((failure) => failure.providerFailure).length,
  );
}

function summarizeResults(results: PulseForkPlanResult[], providerFailures: number): PulseForkPlanSummary {
  const ordered = [...results].sort((left, right) => compareCanonicalStrings(left.sourceMetricId, right.sourceMetricId));
  const summary: InternalPulseForkPlanSummary = {
    attempted: ordered.length,
    notAttempted: ordered.filter((result) => result.creationStatus === 'not_attempted').length,
    created: ordered.filter((result) => result.creationStatus === 'created' || result.status === 'created').length,
    existing: ordered.filter((result) => result.creationStatus === 'existing' || result.status === 'existing').length,
    failed: ordered.filter((result) => result.status === 'failed' || result.status === 'ownership_mismatch').length,
    pendingVisibility: ordered.filter((result) => (
      result.reconciliationStatus === 'pending_visibility' || result.status === 'pending_visibility'
    )).length,
    results: ordered,
  };
  Object.defineProperty(summary, providerFailureCount, { value: providerFailures, enumerable: false });
  return summary;
}

function canonicalIdentifiers(values: unknown[], label: string): string[] {
  return [...new Set(values.map((value, index) => identifier(value, `${label}[${index}]`)))]
    .sort(compareCanonicalStrings);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalidRequest(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > 256) {
    throw invalidRequest(`${label} must contain between 1 and 256 characters.`);
  }
  return normalized;
}

function clauseExclude(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalidRequest(`${label} must be a boolean.`);
  return value;
}

function selectedValues(values: unknown[], label: string): string[] {
  return [...new Set(values.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw invalidRequest(`${label}[${index}] must be a non-blank string.`);
    }
    if (Array.from(value).length > DIMENSIONAL_FORK_LIMITS.valueCharacters) {
      throw invalidRequest(`${label}[${index}] exceeds the maximum length.`);
    }
    return value;
  }))].sort(compareCanonicalStrings);
}

function normalizedDomain(rows: unknown[]): Set<string> {
  const values = new Set<string>();
  for (const row of rows) {
    const value = Array.isArray(row)
      ? row[0]
      : isRecord(row)
        ? Object.values(row)[0]
        : row;
    if (typeof value === 'string' && value.trim()) values.add(value);
  }
  return values;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
  control?: { stopped: boolean; notStarted: (value: T) => R },
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = control?.stopped ? control.notStarted(values[index]!) : await worker(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

function rethrowAuth(error: unknown): void {
  if (error instanceof TableauError && error.kind === 'auth') throw error;
}

function invalidRequest(message: string): PulseForkPlanError {
  return new PulseForkPlanError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
