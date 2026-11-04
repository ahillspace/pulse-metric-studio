import type { TableauSession } from '@pulse-metric-studio/core';
import {
  getFieldCatalog,
  assertTableauMutationAdmission,
  getSessionContext,
  isSessionCurrent,
  TableauError,
  withTableauOperation,
} from '@pulse-metric-studio/core';
import type {
  PulseVariantRequestV1,
  PulseVariantResult,
  PulseVariantSummary,
} from '@pulse-metric-studio/shared';
import {
  compareCanonicalStrings,
  DIMENSIONAL_FORK_LIMITS,
  resolveTimeframe,
  type CatalogField,
  type DatasourceCatalog,
} from '@pulse-metric-studio/shared';
import { mutationMetadata, latestThrottle } from '../application/mutation-metadata.js';
import { exactMetricVariant } from '../application/inventory.js';
import { patchPulseInventory, beginInventoryMutation, endInventoryMutation, resolveInventoryMutationBase } from '../application/inventory-snapshots.js';
import { defaultSourceNamespace, resolveSourceContext, resolveSourceCatalog, type SourceContext } from './source-context.js';
import { timeframeMeasurementPeriod } from '../domain/variants.js';
import { pulseOperationErrorMessage, vdsCatalogFailureMessage } from './operation-errors.js';
import { mergePulseStringFilter } from './dimensional-fork-service.js';
import {
  getOrCreatePulseMetric,
  getPulseDefinition,
  getPulseMetric,
  queryPulseDimensionValues,
  type PulseDefinition,
  type PulseExactMetric,
} from './pulse-client.js';
import {
  metricDefinitionId,
  metricSpecification,
} from './metric-facts.js';

const PROVIDER_CONCURRENCY = 5;
const providerFailureCount = Symbol('providerFailureCount');

export type PulseForkPlanStatus = PulseVariantResult['status'];
export type PulseForkPlanRequestV1 = PulseVariantRequestV1;
export type PulseForkPlanResult = PulseVariantResult;
export type PulseForkPlanSummary = PulseVariantSummary;

type InternalPulseForkPlanSummary = PulseForkPlanSummary & {
  [providerFailureCount]?: number;
};

export interface PulseForkPlanDependencies {
  getMetric(
    session: TableauSession,
    metricId: string,
  ): Promise<PulseExactMetric>;
  getDefinition(
    session: TableauSession,
    definitionId: string,
  ): Promise<PulseDefinition>;
  getCatalog(
    session: TableauSession,
    datasourceLuid: string,
  ): Promise<DatasourceCatalog>;
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
  ): Promise<{ metricId: string | null; created: boolean; raw?: unknown }>;

}

const defaultDependencies: PulseForkPlanDependencies = {
  getMetric: getPulseMetric,
  getDefinition: getPulseDefinition,
  getCatalog: async (session, datasourceLuid) => {
    return getFieldCatalog(session, datasourceLuid);
  },
  queryValues: queryPulseDimensionValues,
  getOrCreate: getOrCreatePulseMetric,
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
  constructor(
    message: string,
    public readonly statusCode: 400 = 400,
  ) {
    super(message);
    this.name = 'PulseForkPlanError';
  }
}

export class PulseForkPlanService {
  constructor(
    private readonly dependencies: PulseForkPlanDependencies = defaultDependencies,
  ) {}

  async forkMetrics(
    session: TableauSession,
    input: unknown,
  ): Promise<PulseForkPlanSummary> {
    const request = canonicalizeForkPlanRequest(input);
    assertTableauMutationAdmission(session);
    const sessionContext = getSessionContext(session);
    const capturedSiteId = session.siteId;
    const capturedCoordinates = JSON.stringify([session.serverUrl, session.siteId, session.userId]);
    const current = () => getSessionContext(session) === sessionContext && JSON.stringify([session.serverUrl, session.siteId, session.userId]) === capturedCoordinates && (!sessionContext || isSessionCurrent(session));
    const commandOwner = isRecord(input) && isRecord(input.context) ? input.context as import('@pulse-metric-studio/shared').PulseDraftContext : undefined;
    const admittedSnapshotId = request.snapshotId && commandOwner ? resolveInventoryMutationBase(session, commandOwner, request.snapshotId) : undefined;
    const admittedSequence = admittedSnapshotId && commandOwner ? beginInventoryMutation(session, commandOwner, admittedSnapshotId) : undefined;
    try {
    let sourceContext: SourceContext | undefined;
    const resolved: ResolvedSource[] = [];
    const failures: FailedResult[] = [];

    let sourceOutcomes: Array<ResolvedSource | FailedResult>;
    try {
      sourceContext = await resolveSourceContext(session, request.sourceMetricIds, request, this.dependencies, this.dependencies === defaultDependencies ? defaultSourceNamespace : this.dependencies);
      sourceOutcomes = [...sourceContext.sources, ...sourceContext.failures.map(failure => { rethrowAuth(failure.error); return failedResult(failure.metricId, failure.error, failure.error instanceof TableauError); })];
    } catch (error) {
      rethrowAuth(error);
      sourceOutcomes = request.sourceMetricIds.map(id => failedResult(id, error, error instanceof TableauError));
    }

    for (const outcome of sourceOutcomes) {
      if ('result' in outcome) failures.push(outcome);
      else resolved.push(outcome);
    }

    if (resolved.length === 0) return summarize(failures);


    const datasourceLuids = [
      ...new Set(resolved.map((source) => source.datasourceLuid)),
    ];
    const expectedDatasource =
      isRecord(input) && isRecord(input.context)
        ? input.context.datasourceLuid
        : undefined;
    if (
      expectedDatasource !== undefined &&
      datasourceLuids.some((id) => id !== expectedDatasource)
    ) {
      throw new PulseForkPlanError(
        'Source metrics do not belong to the selected datasource.',
      );
    }
    if (datasourceLuids.length !== 1) {
      const error = new Error(
        'Selected source metrics must use the same datasource.',
      );
      failures.push(
        ...resolved.map((source) =>
          failedResult(source.metricId, error, false),
        ),
      );
      return summarize(failures);
    }

    let clauses: ResolvedClause[];
    try {
      clauses = await this.resolveClauses(
        session,
        datasourceLuids[0]!,
        resolved,
        request, sourceContext,
      );
    } catch (error) {
      rethrowAuth(error);
      const providerFailure = error instanceof TableauError;
      failures.push(
        ...resolved.map((source) =>
          failedResult(source.metricId, error, providerFailure),
        ),
      );
      return summarize(failures);
    }

    const measurementPeriod = request.timeframe
      ? timeframeMeasurementPeriod(
          resolveTimeframe(
            request.timeframe.key,
            request.timeframe.customDays,
          )!,
        )
      : undefined;
    const plans = new Map<
      string,
      { source: ResolvedSource; specification: Record<string, unknown>; sourceMetricIds: string[] }
    >();
    for (const source of resolved) {
      try {
        let specification = structuredClone(source.specification);
        delete specification.datasource;
        if (measurementPeriod)
          specification.measurement_period = structuredClone(measurementPeriod);
        for (const clause of clauses) {
          specification = mergePulseStringFilter(
            specification,
            clause.fieldName,
            clause.values,
            clause.exclude,
          );
        }
        const key = `${source.definitionId}\u0000${canonicalDestination(specification)}`;
        const retained = plans.get(key);
        if (retained) retained.sourceMetricIds.push(source.metricId);
        else plans.set(key, { source, specification, sourceMetricIds: [source.metricId] });
      } catch (error) {
        failures.push(failedResult(source.metricId, error, false));
      }
    }

    const mutationControl = {
      stopped: false,
      notStarted: ({
        source,
        specification,
      }: {
        source: ResolvedSource;
        specification: Record<string, unknown>;
      }): FailedResult =>
        failedResult(
          source.metricId,
          new Error(
            'Not sent because the Tableau session ended. Reconnect before retrying.',
          ),
          false,
          specification,
          undefined,
          'failed',
          { creationStatus: 'not_attempted' },
        ),
    };
    const planned = [...plans.values()];
    const createDestination = async ({ source, specification }: typeof planned[number]): Promise<PulseForkPlanResult | FailedResult> => {
      let response: { metricId: string | null; created: boolean; raw?: unknown } | undefined;
      try {
        response = await this.dependencies.getOrCreate(session, {
          definitionId: source.definitionId,
          specification,
        });
        if (typeof response.created !== 'boolean' || typeof response.metricId !== 'string' || !response.metricId.trim()) {
          return failedResult(
            source.metricId,
            new Error(
              'Tableau returned no metric identifier; creation outcome is unknown.',
            ),
            true,
            specification,
            undefined,
            'failed',
            { creationStatus: 'unknown' },
          );
        }
        const creationStatus = response.created ? 'created' as const : 'existing' as const;
        const raw = response.raw;
        const providerMetric = isRecord(raw) && isRecord(raw.metric) ? raw.metric as PulseExactMetric : undefined;
        try {
          if (typeof response.created !== 'boolean' || typeof response.metricId !== 'string' || !response.metricId.trim()) throw new Error('Tableau returned invalid creation fields.');
          if (providerMetric) {
            if ((providerMetric.id !== undefined && providerMetric.id !== response.metricId) || (providerMetric.metadata?.id !== undefined && providerMetric.metadata.id !== response.metricId)) throw new Error('Tableau returned conflicting metric identifiers.');
            const actualDefinition = metricDefinitionId(providerMetric);
            const actualSite = providerMetric.site_id ?? providerMetric.site?.id;
            const actualSpecification = metricSpecification(providerMetric);
            const actualDatasource = isRecord(actualSpecification?.datasource) ? actualSpecification.datasource.id : undefined;
            if ((actualDefinition && actualDefinition !== source.definitionId) || (actualSite && actualSite !== capturedSiteId) || (actualDatasource && actualDatasource !== source.datasourceLuid)) throw new Error('Tableau returned conflicting metric ownership.');
            if (actualSpecification) {
              const comparable = structuredClone(actualSpecification); delete comparable.datasource;
              if (canonicalDestination(comparable) !== canonicalDestination(specification)) throw new Error('Tableau returned a conflicting metric specification.');
            }
          }
        } catch (error) { return failedResult(source.metricId, error, false, specification, response.metricId, 'ownership_mismatch', { creationStatus }); }
        const metric = exactMetricVariant(response.metricId, {}, { ...providerMetric, id: response.metricId, definition_id: source.definitionId, specification: structuredClone(specification) });
        return { sourceMetricId: source.metricId, definitionId: source.definitionId, status: creationStatus, creationStatus, sent: true, metricId: response.metricId, metric, requestedSpecification: specification };

      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth')
          mutationControl.stopped = true;
        return failedResult(
          source.metricId,
          error,
          true,
          specification,
          response?.metricId ?? undefined,
          'failed',
          {
            creationStatus: response?.metricId
              ? response.created
                ? 'created'
                : 'existing'
              : isUnsent(error) ? 'not_attempted' : confirmedCreationRejection(error) ? 'failed' : 'unknown',

          },
        );
      }
    };
    const created: Array<PulseForkPlanResult | FailedResult> = [];
    for (let offset = 0; offset < planned.length; offset += PROVIDER_CONCURRENCY) {
      created.push(...await Promise.all(
        planned.slice(offset, offset + PROVIDER_CONCURRENCY).map(plan =>
          mutationControl.stopped || !current() ? mutationControl.notStarted(plan) : createDestination(plan)),
      ));
    }

    const results: PulseForkPlanResult[] = failures.map(
      (failure) => failure.result,
    );
    let providerFailures = failures.filter(
      (failure) => failure.providerFailure,
    ).length;
    for (const [index, outcome] of created.entries()) {
      if ('result' in outcome) {
        results.push(outcome.result);
        if (outcome.providerFailure) providerFailures++;
      } else {
        results.push(outcome);
      }
      const primary = 'result' in outcome ? outcome.result : outcome;
      for (const sourceMetricId of planned[index]!.sourceMetricIds.slice(1)) {
        results.push({ ...structuredClone(primary), sourceMetricId,
          sharedWithSourceMetricId: primary.sourceMetricId,
          ...(primary.creationStatus === 'created' ? { creationStatus: 'existing' as const } : {}),
        });
      }
    }
    const summary = summarizeResults(results, providerFailures);
    if (mutationControl.stopped) summary.terminated = true;
    if (admittedSnapshotId && commandOwner && current()) {
      const upserts = results.flatMap(result => result.metric && result.definitionId && !result.sharedWithSourceMetricId ? [{ definitionId: result.definitionId, metric: result.metric }] : []);
      if (upserts.length) summary.inventoryPatch = patchPulseInventory(session, commandOwner, admittedSnapshotId, { upserts, removedMetricIds: [], removedDefinitionIds: [] }, admittedSequence);
    }
    return summary;
    } finally {
      if (admittedSnapshotId && commandOwner && admittedSequence !== undefined) endInventoryMutation(session, commandOwner, admittedSnapshotId);
    }
  }

  private async resolveClauses(
    session: TableauSession,
    datasourceLuid: string,
    sources: ResolvedSource[],
    request: PulseForkPlanRequestV1,
    sourceContext?: SourceContext,
  ): Promise<ResolvedClause[]> {
    if (request.clauses.length === 0) return [];
    const catalog = sourceContext ? await resolveSourceCatalog(session, sourceContext, this.dependencies) : await withTableauOperation('fork_catalog', () => this.dependencies.getCatalog(session, datasourceLuid));
    if (catalog.source !== 'vds') {
      throw new Error(
        vdsCatalogFailureMessage(catalog),
      );
    }
    const fieldsById = eligibleFieldsById(catalog.dimensions, sources);
    const clauses = request.clauses.map((clause): ResolvedClause => {
      const field = fieldsById.get(clause.fieldId);
      if (!field)
        throw new Error(
          `Field ${clause.fieldId} is not eligible for every source metric.`,
        );
      return {
        fieldId: clause.fieldId,
        fieldName: field.name,
        exclude: clause.selection.exclude,
        values: clause.selection.values,
      };
    });

    await mapWithConcurrency(clauses, PROVIDER_CONCURRENCY, async (clause) => {
      if (clause.values.length === 0) return;
      // Validate the selected values with a targeted set-filter query bounded by
      // the selection size, not the domain size. This confirms values from
      // large (search-required) dimensions that lie beyond any bounded listing.
      const rows = await withTableauOperation('fork_filter_validation', () => this.dependencies.queryValues(session, {
        datasourceLuid,
        fieldName: clause.fieldName,
        rowLimit: clause.values.length,
        matchValues: clause.values,
      }));
      const present = normalizedDomain(rows);
      if (clause.values.some((value) => !present.has(value))) {
        throw new Error(
          `One or more selected values are not in the current domain for field ${clause.fieldId}.`,
        );
      }
    });
    return clauses;
  }
}

export function canonicalizeForkPlanRequest(
  input: unknown,
): PulseForkPlanRequestV1 {
  if (!isRecord(input)) throw invalidRequest('Request body must be an object.');
  if (input.version !== 1) throw invalidRequest('version must equal 1.');
  if (!Array.isArray(input.sourceMetricIds))
    throw invalidRequest('sourceMetricIds must be an array.');
  const sourceMetricIds = canonicalIdentifiers(
    input.sourceMetricIds,
    'sourceMetricIds',
  );
  if (sourceMetricIds.length === 0)
    throw invalidRequest('At least one sourceMetricId is required.');
  if (!Array.isArray(input.clauses))
    throw invalidRequest('clauses must be an array.');

  const clausesByField = new Map<
    string,
    { values: Set<string>; exclude: boolean }
  >();
  for (const [index, candidate] of input.clauses.entries()) {
    if (!isRecord(candidate))
      throw invalidRequest(`clauses[${index}] must be an object.`);
    const fieldId = opaqueFieldIdentifier(candidate.fieldId, `clauses[${index}].fieldId`);
    if (
      !isRecord(candidate.selection) ||
      candidate.selection.mode !== 'VALUES'
    ) {
      throw invalidRequest(
        `clauses[${index}].selection.mode must equal VALUES.`,
      );
    }
    if (
      !Array.isArray(candidate.selection.values) ||
      candidate.selection.values.length === 0
    ) {
      throw invalidRequest(
        `clauses[${index}].selection.values must be a non-empty array.`,
      );
    }
    const exclude = clauseExclude(
      candidate.selection.exclude,
      `clauses[${index}].selection.exclude`,
    );
    const values = selectedValues(
      candidate.selection.values,
      `clauses[${index}].selection.values`,
    );
    let merged = clausesByField.get(fieldId);
    if (!merged) {
      merged = { values: new Set<string>(), exclude };
      clausesByField.set(fieldId, merged);
    } else if (merged.exclude !== exclude) {
      // A field is either an include or an exclude filter, never both at once.
      throw invalidRequest(
        `clauses[${index}] mixes include and exclude for field ${fieldId}.`,
      );
    }
    for (const value of values) merged.values.add(value);
  }

  let timeframe: PulseForkPlanRequestV1['timeframe'];
  if (input.timeframe !== undefined) {
    if (!isRecord(input.timeframe))
      throw invalidRequest('timeframe must be an object.');
    const key = identifier(input.timeframe.key, 'timeframe.key');
    const customDays = input.timeframe.customDays;
    if (key !== 'CUSTOM_N_DAYS' && customDays !== undefined) {
      throw invalidRequest('customDays is supported only for CUSTOM_N_DAYS.');
    }
    if (
      !resolveTimeframe(
        key,
        typeof customDays === 'number' ? customDays : undefined,
      )
    ) {
      throw invalidRequest(`Unknown or invalid timeframe ${key}.`);
    }
    timeframe = {
      key,
      ...(customDays !== undefined ? { customDays: customDays as number } : {}),
    };
  }
  if (!timeframe && clausesByField.size === 0) {
    throw invalidRequest(
      'A timeframe or at least one dimensional clause is required.',
    );
  }

  return {
    version: 1,
    sourceMetricIds,
    ...(typeof input.snapshotId === 'string' ? { snapshotId: input.snapshotId } : {}),
    ...(typeof input.sourceContextId === 'string' ? { sourceContextId: input.sourceContextId } : {}),
    ...(timeframe ? { timeframe } : {}),
    clauses: [...clausesByField.entries()]
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([fieldId, { values, exclude }]) => ({
        fieldId,
        selection: {
          mode: 'VALUES' as const,
          exclude,
          values: [...values].sort(compareCanonicalStrings),
        },
      })),
  };
}

export function forkPlanHttpStatus(
  summary: PulseForkPlanSummary,
): 200 | 207 | 422 | 429 | 502 {
  if (summary.throttle && summary.results.every(result => result.sent === false)) return 429;
  if (summary.failed === 0) return 200;
  if (summary.created + summary.existing > 0) return 207;
  const destinations = summary.results.filter(result => !result.sharedWithSourceMetricId).length;
  if (summary.failed < destinations) return 207;
  return (summary as InternalPulseForkPlanSummary)[providerFailureCount] ===
    summary.failed
    ? 502
    : 422;
}

export const pulseForkPlanService = new PulseForkPlanService();

function eligibleFieldsById(
  fields: CatalogField[],
  sources: ResolvedSource[],
): Map<string, CatalogField> {
  const nameCounts = new Map<string, number>();
  for (const field of fields)
    nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1);
  return new Map(
    fields
      .filter(
        (field) =>
          field.role === 'DIMENSION' &&
          field.dataType.toUpperCase() === 'STRING',
      )
      .filter((field) => nameCounts.get(field.name) === 1)
      .filter((field) =>
        sources.every((source) => source.allowedDimensions.has(field.name)),
      )
      .map((field) => [field.id, field]),
  );
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
  return {
    result: {
      sourceMetricId,
      status,
      creationStatus: 'not_attempted',
      ...mutationMetadata(error, context.creationStatus === undefined || context.creationStatus === 'not_attempted'),
      ...context,
      ...(metricId ? { metricId } : {}),
      requestedSpecification,
      error: pulseOperationErrorMessage(error, 'fork'),
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

function summarizeResults(
  results: PulseForkPlanResult[],
  providerFailures: number,
): PulseForkPlanSummary {
  const ordered = [...results].sort((left, right) =>
    compareCanonicalStrings(left.sourceMetricId, right.sourceMetricId),
  );
  const destinations = ordered.filter(result => !result.sharedWithSourceMetricId);
  const throttle = latestThrottle(destinations);
  const summary: InternalPulseForkPlanSummary = {
    ...(throttle ? { throttle, sent: destinations.some(result => result.sent === true) } : {}),
    attempted: ordered.length,
    notAttempted: destinations.filter(
      (result) => result.creationStatus === 'not_attempted',
    ).length,
    created: destinations.filter(
      (result) =>
        (result.creationStatus ?? result.status) === 'created',
    ).length,
    existing: destinations.filter(
      (result) =>
        (result.creationStatus ?? result.status) === 'existing',
    ).length,
    failed: destinations.filter(
      (result) =>
        result.status === 'failed' || result.status === 'ownership_mismatch',
    ).length,
    pendingVisibility: destinations.filter(
      (result) =>
        result.reconciliationStatus === 'pending_visibility' ||
        result.status === 'pending_visibility',
    ).length,
    results: ordered,
  };
  Object.defineProperty(summary, providerFailureCount, {
    value: providerFailures,
    enumerable: false,
  });
  return summary;
}

function confirmedCreationRejection(error: unknown): boolean {
  return error instanceof TableauError && error.kind !== 'network'
    && [400, 401, 403, 404, 409, 422, 429].includes(error.status);
}

function canonicalIdentifiers(values: unknown[], label: string): string[] {
  return [
    ...new Set(
      values.map((value, index) => identifier(value, `${label}[${index}]`)),
    ),
  ].sort(compareCanonicalStrings);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw invalidRequest(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > 256) {
    throw invalidRequest(`${label} must contain between 1 and 256 characters.`);
  }
  return normalized;
}

function opaqueFieldIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024)
    throw invalidRequest(`${label} must be a non-blank field identifier of at most 1024 characters.`);
  return value;
}

function clauseExclude(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean')
    throw invalidRequest(`${label} must be a boolean.`);
  return value;
}

function selectedValues(values: unknown[], label: string): string[] {
  return [
    ...new Set(
      values.map((value, index) => {
        if (typeof value !== 'string' || !value.trim()) {
          throw invalidRequest(
            `${label}[${index}] must be a non-blank string.`,
          );
        }
        if (
          Array.from(value).length > DIMENSIONAL_FORK_LIMITS.valueCharacters
        ) {
          throw invalidRequest(
            `${label}[${index}] exceeds the maximum length.`,
          );
        }
        return value;
      }),
    ),
  ].sort(compareCanonicalStrings);
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

function canonicalDestination(specification: Record<string, unknown>): string {
  const normalized = structuredClone(specification);
  if (Array.isArray(normalized.filters)) {
    normalized.filters = normalized.filters.map((filter: unknown) => {
      if (!isRecord(filter)) return filter;
      if (Array.isArray(filter.categorical_values)) {
        filter.categorical_values = [...new Map(filter.categorical_values.map((value: unknown) => [stableJson(value), value])).values()]
          .sort((left, right) => compareCanonicalStrings(stableJson(left), stableJson(right)));
      }
      return filter;
    }).sort((left, right) => compareCanonicalStrings(stableJson(left), stableJson(right)));
  }
  return stableJson(normalized);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, run),
  );
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

function isUnsent(error: unknown): boolean { return error !== null && typeof error === 'object' && 'sent' in error && error.sent === false; }
