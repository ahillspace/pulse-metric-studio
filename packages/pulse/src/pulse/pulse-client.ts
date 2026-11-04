interface PulseDefinitionResponse { definition?: { metadata?: { id?: string; name?: string } } }
import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError,TableauResponseSizeError,apiPath,deleteReq,getJson,isPastEndError,postJson,logTableauEvent,withTableauOperation } from '@pulse-metric-studio/core';
import { boundedProviderDiagnostic,type PulseProviderDiagnostic } from './provider-diagnostics.js';
import { pulseOperationErrorMessage } from './operation-errors.js';

/**
 * Pulse REST wrapper (`/api/-/pulse`). Contract recovered from the working
 * Juju implementation and pinned here once (ledger C5).
 */

const PULSE = '/api/-/pulse';

const CREATE_DEFINITION_HEADERS = {
  contentType: 'application/vnd.tableau.metricqueryservice.v1.CreateDefinitionRequest+json',
  accept: 'application/vnd.tableau.metricqueryservice.v1.CreateDefinitionResponse+json',
} as const;

export interface PulseDefinition {
  metadata?: { id?: string; name?: string; description?: string };
  specification?: {
    datasource?: { id?: string };
    basic_specification?: {
      measure?: { field?: string; aggregation?: string };
      time_dimension?: { field?: string };
    };
  };
  metric_specification?: Record<string, unknown>;
  extension_options?: { allowed_dimensions?: string[] };
}

export interface PulseExactMetric {
  metadata?: { id?: string; name?: string };
  id?: string;
  is_default?: boolean;
  site_id?: string;
  site?: { id?: string };
  definition_id?: string;
  definition?: { metadata?: { id?: string } };
  specification_reference?: { definition_id?: string };
  specification?: Record<string, unknown>;
  metric_specification?: Record<string, unknown>;
}

export interface PulseMetricInventory {
  metrics: PulseExactMetric[];
  truncated: boolean;
  diagnostic?: PulseProviderDiagnostic;
  /** Preserve a terminal local limit while retaining a useful partial prefix for inventory views. */
  responseSizeExceeded?: true;
}

export async function createDefinition(
  session: TableauSession,
  payload: Record<string, unknown>,
): Promise<{ definitionId: string | null; raw: PulseDefinitionResponse }> {
  const data = await postJson<PulseDefinitionResponse>(session, `${PULSE}/definitions`, payload, CREATE_DEFINITION_HEADERS);
  return { definitionId: data?.definition?.metadata?.id ?? null, raw: data };
}

export interface PulseDefinitionInventory {
  definitions: PulseDefinition[];
  truncated: boolean;
}

export async function listDefinitionsInventory(
  session: TableauSession,
  maxPages = 200,
): Promise<PulseDefinitionInventory> {
  const definitions: PulseDefinition[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let path = `${PULSE}/definitions?page_size=100`;
    if (pageToken) path += `&page_token=${encodeURIComponent(pageToken)}`;
    const data = await getJson<{ definitions?: PulseDefinition[]; next_page_token?: string | null }>(session, path);
    if (!Array.isArray(data?.definitions)) {
      throw new TableauError('Pulse definitions response requires a definitions array', 502, boundedJson(data));
    }
    definitions.push(...data.definitions);
    pageToken = typeof data.next_page_token === 'string' && data.next_page_token ? data.next_page_token : null;
    if (!pageToken) return { definitions, truncated: false };
  }
  return { definitions, truncated: pageToken !== null };
}

export async function listDefinitions(session: TableauSession, maxPages = 200): Promise<PulseDefinition[]> {
  return (await listDefinitionsInventory(session, maxPages)).definitions;
}

export async function getPulseDefinition(session: TableauSession, definitionId: string, maxResponseBytes?: number): Promise<PulseDefinition> {
  const data = await getJson<unknown>(
    session,
    `${PULSE}/definitions/${encodeURIComponent(definitionId)}`,
    undefined, undefined, maxResponseBytes,
  );
  const candidate = isRecord(data) && isRecord(data.definition) ? data.definition : data;
  if (!isRecord(candidate)) throw unsupportedContract('definition', data);
  return candidate as PulseDefinition;
}

export async function getPulseMetric(session: TableauSession, metricId: string, maxResponseBytes?: number): Promise<PulseExactMetric> {
  const data = await getJson<unknown>(
    session,
    `${PULSE}/metrics/${encodeURIComponent(metricId)}`,
    undefined, undefined, maxResponseBytes,
  );
  const candidate = isRecord(data) && isRecord(data.metric) ? data.metric : data;
  if (!isRecord(candidate)) throw unsupportedContract('metric', data);
  return candidate as PulseExactMetric;
}

export async function listMetricsInventory(
  session: TableauSession,
  definitionId: string,
  limits: { maxPages?: number; maxItems?: number } = {},
): Promise<PulseMetricInventory> {
  const metrics: PulseExactMetric[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  const maxPages = Math.max(1, Math.trunc(limits.maxPages ?? 200));
  const maxItems = Math.max(1, Math.trunc(limits.maxItems ?? 100000));
  let token = '';
  let advertisedTotal = 0;
  const partial = (message: string): PulseMetricInventory => ({ metrics, truncated: true, diagnostic: { message } });
  for (let page = 0; page < maxPages; page++) {
    let data: unknown;
    try {
      const query = new URLSearchParams({ page_size: '100' });
      if (token) query.set('page_token', token);
      data = await getJson<unknown>(session, `${PULSE}/definitions/${encodeURIComponent(definitionId)}/metrics?${query}`);
    } catch (error) {
      if ((error instanceof TableauError && error.kind === 'auth') || page === 0) throw error;
      return { metrics, truncated: true, diagnostic: boundedProviderDiagnostic(error), ...(error instanceof TableauResponseSizeError ? { responseSizeExceeded: true as const } : {}) };
    }
    if (!isRecord(data) || !Array.isArray(data.metrics)) return partial('Pulse metric inventory page requires a metrics array.');
    if (data.total_available !== undefined) {
      if (!Number.isSafeInteger(data.total_available) || (data.total_available as number) < 0)
        return partial('Pulse metric inventory has an invalid total.');
      advertisedTotal = Math.max(advertisedTotal, data.total_available as number);
    }
    const before = metrics.length;
    for (const record of data.metrics) {
      if (!isRecord(record)) return partial('Pulse metric inventory contains a malformed record.');
      const metadata = isRecord(record.metadata) ? record.metadata : undefined;
      const id = stringValue(record.id ?? metadata?.id);
      if (!id) return partial('Pulse metric inventory contains a record without an identifier.');
      if (ids.has(id)) continue;
      if (metrics.length >= maxItems) return partial('Pulse metric inventory exceeds the local item limit.');
      ids.add(id);
      metrics.push(record as PulseExactMetric);
    }
    const next = data.next_page_token;
    if (next === undefined || next === null || next === '') {
      if (advertisedTotal > metrics.length)
        return partial('Pulse metric inventory ended before its advertised total or has an invalid total.');
      // Exhaustion of the continuation protocol establishes completion, even when no total is supplied.
      return { metrics, truncated: false };
    }
    if (typeof next !== 'string' || !next.trim() || tokens.has(next) || metrics.length === before)
      return partial('Pulse metric inventory has an invalid or repeated continuation.');
    tokens.add(next);
    token = next;
  }
  return partial('Pulse metric inventory exceeds the local page limit.');
}

/** Callers requiring a complete list must not silently consume a partial prefix. */
export async function listMetricsForDefinition(session: TableauSession, definitionId: string): Promise<PulseExactMetric[]> {
  const inventory = await listMetricsInventory(session, definitionId);
  if (inventory.truncated) {
    if (inventory.responseSizeExceeded) throw new TableauResponseSizeError();
    const diagnostic = inventory.diagnostic;
    if (diagnostic?.status !== undefined)
      throw new TableauError(diagnostic.message, diagnostic.status, diagnostic.detail ?? '', diagnostic.kind ?? 'http', diagnostic.providerCode);
    throw new PulseContractError(diagnostic?.message ?? 'Pulse metric inventory is incomplete.');
  }
  return inventory.metrics;
}

/**
 * Resolve the default metric created for a fresh definition.
 * Tableau creates it asynchronously (ledger A3), so poll briefly before giving up.
 */
export async function resolveDefaultMetricId(
  session: TableauSession,
  definitionId: string,
  attempts = 6,
): Promise<string | null> {
  let lastFailure: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1200 * i);
    try {
      const metrics = await listMetricsForDefinition(session, definitionId);
      // A healthy empty read establishes propagation delay rather than failed access.
      lastFailure = undefined;
      const candidate = metrics.find((metric) => metric.is_default === true)
        ?? metrics.find((metric) => isMonthToDate(metric.specification))
        ?? (metrics.length === 1 ? metrics[0] : undefined);
      const id = candidate?.id ?? candidate?.metadata?.id ?? null;
      if (id) {
        const specification = candidate?.specification
          ?? (await getPulseMetric(session, id)).specification;
        if (!isMonthToDate(specification)) {
          throw new UnexpectedDefaultMetricError(
            'Tableau created the definition, but its initial metric is not month-to-date. Open it in Pulse to review its timeframe.',
          );
        }
        return id;
      }
    } catch (e) {
      const retryable = e instanceof TableauError && !(e instanceof PulseContractError) && !(e instanceof TableauResponseSizeError)
        && e.kind !== 'auth' && (e.kind === 'network' || [404, 408, 429].includes(e.status) || e.status >= 500);
      if (!retryable) throw e;
      lastFailure = e;
    }
  }
  if (lastFailure !== undefined) throw lastFailure;
  return null;
}

class UnexpectedDefaultMetricError extends Error {}

/** A successful HTTP read with an unusable provider contract cannot establish pending visibility. */
class PulseContractError extends TableauError {
  constructor(message: string, body = '') { super(message, 502, body); }
}

function isMonthToDate(specification: unknown): boolean {
  if (!isRecord(specification) || !isRecord(specification.measurement_period)) return false;
  return specification.measurement_period.granularity === 'GRANULARITY_BY_MONTH'
    && specification.measurement_period.range === 'RANGE_CURRENT_PARTIAL';
}

export interface ForkResult {
  metricId: string | null;
  created: boolean;
  raw: unknown;
}

/**
 * Create an exact metric through the one pinned Pulse get-or-create envelope.
 */
export async function getOrCreatePulseMetric(
  session: TableauSession,
  input: { definitionId: string; specification: Record<string, unknown> },
): Promise<ForkResult & { metricApiName?: string }> {
  const body = {
    definition_id: input.definitionId,
    specification: input.specification,
  };
  const data = await withTableauOperation('get_or_create', () => postJson<any>(session, `${PULSE}/metrics:getOrCreate`, body, {
    accept: 'application/vnd.tableau.metricqueryservice.v1.GetOrCreateMetricResponse+json',
    contentType: 'application/vnd.tableau.metricqueryservice.v1.GetOrCreateMetricRequest+json',
  }));
  const created = requireMetricCreatedFlag(data);
  const metricId = data?.metric?.metadata?.id ?? data?.metric?.id ?? null;
  logTableauEvent({ event: 'tableau.get_or_create', metricId, isMetricCreated: created });
  return {
    metricId,
    metricApiName: data?.metric?.metadata?.name ?? data?.metric?.name,
    created,
    raw: data,
  };
}

export const getOrCreateDimensionalMetric = getOrCreatePulseMetric;

export async function forkMetricToTimeframe(
  session: TableauSession,
  input: { definitionId: string; specification: Record<string, unknown> },
): Promise<ForkResult & { metricApiName?: string }> {
  return getOrCreatePulseMetric(session, input);
}

function requireMetricCreatedFlag(data: unknown): boolean {
  const value = data && typeof data === 'object'
    ? (data as Record<string, unknown>).is_metric_created
    : undefined;
  if (typeof value !== 'boolean') {
    throw new TableauError(
      'Pulse get-or-create response requires a Boolean is_metric_created field',
      502,
      '',
    );
  }
  return value;
}

export async function queryPulseDimensionValues(
  session: TableauSession,
  input: {
    datasourceLuid: string;
    fieldName: string;
    rowLimit: number;
    /** Optional server-side substring (contains) filter for search-required mode. */
    contains?: string;
    /** Optional explicit value set filter, used to validate selected values. */
    matchValues?: string[];
  },
): Promise<Array<[string | null]>> {
  const filters = buildValueFilters(input.fieldName, input);
  const data = await postJson<{ data?: unknown[]; error?: unknown }>(
    session,
    '/api/v1/vizql-data-service/query-datasource',
    {
      datasource: { datasourceLuid: input.datasourceLuid },
      query: {
        fields: [{ fieldCaption: input.fieldName, sortPriority: 1, sortDirection: 'ASC' }],
        ...(filters ? { filters } : {}),
      },
      options: {
        disaggregate: false,
        interpretFieldCaptionsAsFieldNames: true,
        returnFormat: 'ARRAYS',
        rowLimit: input.rowLimit,
        returnServerSentEvents: false,
      },
    },
    { timeoutMs: 30_000 },
  );
  if (hasVdsError(data?.error)) {
    throw new TableauError('VDS distinct-value query returned an error', 502, JSON.stringify(data.error).slice(0, 500));
  }
  if (!Array.isArray(data?.data)) {
    throw new TableauError('VDS distinct-value query returned no data array', 502, JSON.stringify(data?.error ?? '').slice(0, 500));
  }
  const invalidRow = data.data.findIndex((row) => (
    !Array.isArray(row)
    || row.length !== 1
    || (typeof row[0] !== 'string' && row[0] !== null)
  ));
  if (invalidRow >= 0) {
    throw new TableauError(
      'VDS distinct-value query returned an unsupported row shape',
      502,
      boundedJson(data.data[invalidRow]),
    );
  }
  return data.data as Array<[string | null]>;
}

function buildValueFilters(
  fieldName: string,
  input: { contains?: string; matchValues?: string[] },
): Array<Record<string, unknown>> | undefined {
  const field = { fieldCaption: fieldName };
  if (input.matchValues && input.matchValues.length > 0) {
    return [{ field, filterType: 'SET', values: input.matchValues, exclude: false }];
  }
  if (input.contains) {
    return [{ field, filterType: 'MATCH', contains: input.contains, exclude: false }];
  }
  return undefined;
}

export async function queryPulseDimensionDistinctCount(
  session: TableauSession,
  input: { datasourceLuid: string; fieldName: string },
): Promise<number> {
  const data = await postJson<{ data?: unknown[]; error?: unknown }>(
    session,
    '/api/v1/vizql-data-service/query-datasource',
    {
      datasource: { datasourceLuid: input.datasourceLuid },
      query: {
        fields: [{ fieldCaption: input.fieldName, function: 'COUNTD' }],
      },
      options: {
        disaggregate: false,
        interpretFieldCaptionsAsFieldNames: true,
        returnFormat: 'ARRAYS',
        returnServerSentEvents: false,
      },
    },
    { timeoutMs: 30_000 },
  );
  if (hasVdsError(data?.error)) {
    throw new TableauError('VDS distinct-count query returned an error', 502, JSON.stringify(data.error).slice(0, 500));
  }
  const rows = data?.data;
  const cell = Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && rows[0].length === 1
    ? rows[0][0]
    : undefined;
  const count = typeof cell === 'number' ? cell : typeof cell === 'string' ? Number(cell) : NaN;
  if (!Number.isFinite(count) || count < 0) {
    throw new TableauError(
      'VDS distinct-count query returned an unsupported result shape',
      502,
      boundedJson(rows),
    );
  }
  return Math.trunc(count);
}

function hasVdsError(error: unknown): boolean {
  if (error === null || error === undefined || error === '') return false;
  if (Array.isArray(error)) return error.length > 0;
  if (typeof error === 'object') return Object.keys(error as Record<string, unknown>).length > 0;
  return true;
}

// -- subscriptions ------------------------------------------------------------

export type PulseFollowerType = 'USER' | 'GROUP' | 'UNKNOWN';

export interface SubscriptionRecord {
  id?: string;
  follower: {
    id: string;
    type: PulseFollowerType;
    name?: string;
  };
}

export function normalizeSubscriptionEnvelope(data: unknown): SubscriptionRecord[] {
  const records = subscriptionRecords(data);
  return records.map((record, index) => normalizeSubscriptionRecord(record, index));
}

export async function listSubscriptionsForMetric(session: TableauSession, metricId: string): Promise<SubscriptionRecord[]> {
  const subscriptions: SubscriptionRecord[] = [];
  const seenTokens = new Set<string>();
  let token = '';
  for (let page = 0; page < 1000; page++) {
    const query = new URLSearchParams({ metric_id: metricId });
    if (token) query.set('page_token', token);
    const data = await withTableauOperation('subscriptions', () => getJson<unknown>(session, `${PULSE}/subscriptions?${query}`));
    const records = normalizeSubscriptionEnvelope(data);
    subscriptions.push(...records);
    const next = isRecord(data) ? data.next_page_token : undefined;
    logTableauEvent({ event: 'tableau.subscriptions_page', metricId, page: page + 1, recordCount: records.length, hasNextPage: next !== undefined && next !== '' });
    if (next === undefined || next === '') return subscriptions;
    if (typeof next !== 'string' || !next.trim() || seenTokens.has(next) || !records.length)
      throw new TableauError('Pulse follower inventory has an invalid continuation.', 502);
    if (subscriptions.length > 100000)
      throw new TableauError('Pulse follower inventory exceeds the local read limit.', 502);
    seenTokens.add(next);
    token = next;
  }
  throw new TableauError('Pulse follower inventory continuation exceeds the local read limit.', 502);
}

export interface SubscriptionWriteTarget {
  metricId: string;
  targetId: string;
  targetType: 'USER' | 'GROUP';
}
export interface SubscriptionWriteResult {
  metricId: string;
  targetId: string;
  targetType?: 'USER' | 'GROUP';
  ok: boolean;
  alreadyExists: boolean;
  unknown?: boolean;
  error?: string;
}
export class SubscriptionBatchInterrupted extends TableauError {
  readonly failed: { metricId: string; targetId: string };
  constructor(
    cause: TableauError,
    public readonly completed: SubscriptionWriteResult[],
    failed: { metricId: string; targetId: string },
    public readonly failedTargets: SubscriptionWriteTarget[] = [],
    public readonly phase: 'submission' | 'confirmation' = 'submission',
  ) {
    super(cause.message, cause.status, cause.bodySnippet, cause.kind, cause.providerCode, cause.providerInfo);
    this.failed = failed;
  }
}

/** Local request-size bound, not a claimed Tableau provider limit. */
export const SUBSCRIPTION_REQUEST_LIMIT = 200;
export async function batchCreateSubscriptions(session: TableauSession, items: SubscriptionWriteTarget[]): Promise<SubscriptionWriteResult[]> {
  const results: SubscriptionWriteResult[] = [];
  const byMetric = new Map<string, SubscriptionWriteTarget[]>();
  for (const item of items) {
    const group = byMetric.get(item.metricId) ?? [];
    if (!group.some((entry) => entry.targetType === item.targetType && entry.targetId === item.targetId)) group.push(item);
    byMetric.set(item.metricId, group);
  }
  for (const [metricId, recipients] of byMetric) {
    for (let offset = 0; offset < recipients.length; offset += SUBSCRIPTION_REQUEST_LIMIT) {
      const batch = recipients.slice(offset, offset + SUBSCRIPTION_REQUEST_LIMIT);
      let records: SubscriptionRecord[];
      let alreadyExists = false;
      try {
        const data = await postJson<unknown>(session, `${PULSE}/subscriptions:batchCreate`, {
          metric_id: metricId,
          followers: batch.map((item) => item.targetType === 'GROUP' ? { group_id: item.targetId } : { user_id: item.targetId }),
        }, {
          contentType: 'application/vnd.tableau.pulse.subscriptionservice.v1.BatchCreateSubscriptionsRequest+json',
          accept: 'application/vnd.tableau.pulse.subscriptionservice.v1.BatchCreateSubscriptionsResponse+json',
        });
        try { records = normalizeSubscriptionEnvelope({ subscriptions: subscriptionRecords(data).filter((record) => record.metric_id === undefined || record.metric_id === metricId) }); }
        catch { records = []; }
      } catch (error) {
        if (!(error instanceof TableauError) || error.kind === 'auth' || error.kind === 'network' || error.status >= 500) {
          const cause = error instanceof TableauError ? error : new TableauError('Subscription batch outcome is unknown.', 502);
          throw new SubscriptionBatchInterrupted(cause, results, batch[0]!, batch);
        }
        if (isAlreadyFollowedError(error) && batch.length === 1) {
          results.push({ ...batch[0]!, ok: true, alreadyExists: true });
          continue;
        }
        if (error.status === 409) {
          // A conflict says nothing about the other submitted identities. Read evidence, never replay writes.
          try { records = await listSubscriptionsForMetric(session, metricId); alreadyExists = true; }
          catch (verificationError) {
            if (verificationError instanceof TableauError && verificationError.kind === 'auth')
              throw new SubscriptionBatchInterrupted(verificationError, results, batch[0]!, batch, 'confirmation');
            records = [];
          }
        } else {
          results.push(...batch.map((item) => ({ ...item, ok: false, alreadyExists: false, error: pulseOperationErrorMessage(error, 'follow', [session.token]) })));
          continue;
        }
      }
      const identities = new Set(records.map((record) => `${record.follower.type}\u0000${record.follower.id}`));
      for (const item of batch) {
        const confirmed = identities.has(`${item.targetType}\u0000${item.targetId}`);
        results.push({ ...item, ok: confirmed, alreadyExists: confirmed && alreadyExists,
          ...(!confirmed ? { unknown: true, error: 'Tableau did not confirm this submitted recipient. Check follow state before retrying.' } : {}),
        });
      }
    }
  }
  return results;
}

export async function batchCreateGroupSubscriptions(session: TableauSession, items: Array<{ metricId: string; groupId: string }>): Promise<SubscriptionWriteResult[]> {
  return (await batchCreateSubscriptions(session, items.map((item) => ({ metricId: item.metricId, targetId: item.groupId, targetType: 'GROUP' })))).map(({ targetType: _type, ...result }) => result);
}
export async function batchCreateUserSubscriptions(session: TableauSession, items: Array<{ metricId: string; userId: string }>): Promise<SubscriptionWriteResult[]> {
  return (await batchCreateSubscriptions(session, items.map((item) => ({ metricId: item.metricId, targetId: item.userId, targetType: 'USER' })))).map(({ targetType: _type, ...result }) => result);
}

function isAlreadyFollowedError(error: unknown): boolean {
  if (!(error instanceof TableauError) || error.status !== 409) return false;
  return /subscription\s+already\s+exists\s+for\s+this\s+follower/i.test(error.bodySnippet);
}

export async function deleteSubscription(session: TableauSession, subscriptionId: string): Promise<void> {
  await deleteReq(session, `${PULSE}/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export const FOLLOWER_COUNT_BATCH_LIMIT = 200;

export interface FollowerCountBatchResult {
  countsByMetricId: Record<string, number>;
  errorsByMetricId: Record<string, PulseProviderDiagnostic>;
}

export function normalizeFollowerCountEnvelope(data: unknown): Record<string, number> {
  if (!isRecord(data)) throw unsupportedContract('follower-count', data);
  const candidate = Object.hasOwn(data, 'follower_counts')
    ? data.follower_counts
    : Object.hasOwn(data, 'counts')
      ? data.counts
      : undefined;
  if (!Array.isArray(candidate)) throw unsupportedContract('follower-count', data);
  const counts: Record<string, number> = {};
  for (const [index, entry] of candidate.entries()) {
    if (!isRecord(entry)) throw unsupportedContract(`follower-count record ${index}`, entry);
    const metricId = stringValue(entry.metric_id ?? entry.metricId ?? entry.id);
    const rawCount = entry.follower_count ?? entry.followerCount ?? entry.count;
    const count = typeof rawCount === 'number' ? rawCount : Number.NaN;
    if (!metricId || !Number.isInteger(count) || count < 0) {
      throw unsupportedContract(`follower-count record ${index}`, entry);
    }
    counts[metricId] = count;
  }
  return counts;
}

export async function batchGetFollowerCounts(
  session: TableauSession,
  metricIds: string[],
): Promise<FollowerCountBatchResult> {
  const uniqueMetricIds = [...new Set(metricIds.map((metricId) => String(metricId).trim()).filter(Boolean))];
  const result: FollowerCountBatchResult = { countsByMetricId: {}, errorsByMetricId: {} };
  for (let index = 0; index < uniqueMetricIds.length; index += FOLLOWER_COUNT_BATCH_LIMIT) {
    const batch = uniqueMetricIds.slice(index, index + FOLLOWER_COUNT_BATCH_LIMIT);
    try {
      const query = new URLSearchParams({ metric_ids: batch.join(',') });
      const data = await getJson<unknown>(session,
        `${PULSE}/subscriptions:batchGetMetricFollowerCounts?${query}`,
        'application/vnd.tableau.pulse.subscriptionservice.v1.BatchGetMetricFollowerCountsResponse+json');
      const counts = normalizeFollowerCountEnvelope(data);
      for (const metricId of batch) {
        if (Object.hasOwn(counts, metricId)) result.countsByMetricId[metricId] = counts[metricId]!;
        else result.errorsByMetricId[metricId] = {
          message: 'Tableau omitted this metric from the follower-count response.',
        };
      }
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      const diagnostic = boundedProviderDiagnostic(error);
      for (const metricId of batch) result.errorsByMetricId[metricId] = diagnostic;
    }
  }
  return result;
}

export async function getTableauUserName(session: TableauSession, userId: string): Promise<string | null> {
  const data = await getJson<unknown>(
    session,
    `/api/${session.apiVersion}/sites/${encodeURIComponent(session.siteId)}/users/${encodeURIComponent(userId)}`,
  );
  if (!isRecord(data) || !isRecord(data.user)) throw unsupportedContract('user detail', data);
  const name = stringValue(data.user.name ?? data.user.fullName);
  if (!name) throw unsupportedContract('user detail', data);
  return name;
}

const GROUP_LIST_PAGE_SIZE = 1000;
const USER_LIST_PAGE_SIZE = 1000;

/**
 * List every group on the current site (paginated). Tableau REST has no "query
 * single group by id" endpoint - a `GET .../groups/{id}` returns 405 - so
 * callers that need a name-by-id lookup build an id->name map from this listing
 * once. There is no server-side name filter: REST API 3.27 rejects the `has`
 * operator on the `name` key (400065), so the follow-target picker filters the
 * full inventory locally instead.
 */
export async function listTableauGroups(
  session: TableauSession,
): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let pageNumber = 1;
  for (;;) {
    let data: unknown;
    try {
      data = await getJson<unknown>(
        session,
        apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/groups?pageSize=${GROUP_LIST_PAGE_SIZE}&pageNumber=${pageNumber}`),
      );
    } catch (error) {
      if (isPastEndError(error)) break;
      throw error;
    }
    const records = restCollectionRecords(data, 'groups', 'group');
    for (const record of records) {
      const id = stringValue(record.id ?? record.luid);
      const name = stringValue(record.name);
      if (!id || !name) throw unsupportedContract('group directory record', record);
      out.push({ id, name });
    }
    if (records.length < GROUP_LIST_PAGE_SIZE) break;
    pageNumber++;
  }
  return out;
}

/**
 * List every site user as a follow target (paginated until the directory is
 * exhausted - a short page or a past-end error). There is no page cap: the whole
 * directory is always returned so the picker can offer every user. There is no
 * server-side name filter - REST API 3.27 rejects `name:has:` (400065) - so the
 * picker filters the full inventory locally.
 */
export async function listTableauUsers(
  session: TableauSession,
  opts: { pageSize?: number } = {},
): Promise<Array<{ id: string; name: string }>> {
  const pageSize = Math.max(1, Math.trunc(opts.pageSize ?? USER_LIST_PAGE_SIZE));
  const users: Array<{ id: string; name: string }> = [];
  let pageNumber = 1;
  for (;;) {
    let data: unknown;
    try {
      data = await getJson<unknown>(
        session,
        apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/users?pageSize=${pageSize}&pageNumber=${pageNumber}`),
      );
    } catch (error) {
      if (isPastEndError(error)) break;
      throw error;
    }
    const records = restCollectionRecords(data, 'users', 'user');
    for (const record of records) {
      const id = stringValue(record.id ?? record.luid);
      const name = stringValue(record.fullName ?? record.name);
      if (id && name) users.push({ id, name });
    }
    if (records.length < pageSize) break; // short page: the directory is exhausted
    pageNumber++;
  }
  return users;
}

/** Read `{ [plural]: { [singular]: [...] } }` or the flat `{ [singular]: [...] }` REST envelope. */
function restCollectionRecords(data: unknown, plural: string, singular: string): Record<string, unknown>[] {
  if (!isRecord(data)) throw unsupportedContract(`${plural} listing`, data);
  let raw: unknown;
  if (Object.hasOwn(data, plural)) {
    const container = data[plural];
    raw = isRecord(container) ? container[singular] : container;
  } else if (Object.hasOwn(data, singular)) {
    raw = data[singular];
  } else {
    throw unsupportedContract(`${plural} listing`, data);
  }
  if (raw == null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value, index) => {
    if (!isRecord(value)) throw unsupportedContract(`${singular} record ${index}`, value);
    return value;
  });
}

function subscriptionRecords(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return recordArray(data, 'subscription');
  if (!isRecord(data)) throw unsupportedContract('subscription', data);
  if (Object.hasOwn(data, 'subscriptions')) {
    const subscriptions = data.subscriptions;
    if (Array.isArray(subscriptions)) return recordArray(subscriptions, 'subscription');
    if (isRecord(subscriptions) && Object.hasOwn(subscriptions, 'subscription')) {
      return recordLeaf(subscriptions.subscription, 'subscriptions.subscription');
    }
    throw unsupportedContract('subscriptions', subscriptions);
  }
  if (Object.hasOwn(data, 'subscription')) return recordLeaf(data.subscription, 'subscription');
  throw unsupportedContract('subscription', data);
}

function recordLeaf(value: unknown, label: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return recordArray(value, label);
  if (isRecord(value)) return [value];
  throw unsupportedContract(label, value);
}

function recordArray(values: unknown[], label: string): Record<string, unknown>[] {
  return values.map((value, index) => {
    if (!isRecord(value)) throw unsupportedContract(`${label} record ${index}`, value);
    return value;
  });
}

function normalizeSubscriptionRecord(record: Record<string, unknown>, index: number): SubscriptionRecord {
  const nestedSubscription = isRecord(record.subscription) ? record.subscription : undefined;
  const follower = firstRecord(
    record.follower,
    nestedSubscription?.follower,
    record.subscriber,
    record.subject,
    record.user,
    record.group,
    hasDirectFollowerIdentity(record) ? record : undefined,
  );
  if (!follower) throw unsupportedContract(`subscription follower ${index}`, record);

  const nestedUser = isRecord(follower.user) ? follower.user : undefined;
  const nestedGroup = isRecord(follower.group) ? follower.group : undefined;
  const userId = stringValue(follower.user_id ?? follower.userId ?? nestedUser?.id ?? nestedUser?.luid);
  const groupId = stringValue(follower.group_id ?? follower.groupId ?? nestedGroup?.id ?? nestedGroup?.luid);
  if (userId && groupId) throw unsupportedContract(`subscription follower ${index} has conflicting identities`, record);
  const explicitType = stringValue(follower.type ?? follower.subjectType ?? follower.kind).toUpperCase();
  const genericId = stringValue(follower.follower_id ?? follower.followerId ?? follower.id ?? follower.luid);
  const id = groupId || userId || genericId;
  if (!id) throw unsupportedContract(`subscription follower ${index}`, record);

  let type: PulseFollowerType = 'UNKNOWN';
  if (groupId || explicitType.includes('GROUP') || record.group === follower) type = 'GROUP';
  else if (userId || explicitType.includes('USER') || record.user === follower) type = 'USER';

  const name = stringValue(
    follower.name
    ?? follower.fullName
    ?? nestedUser?.name
    ?? nestedUser?.fullName
    ?? nestedGroup?.name,
  );
  const subscriptionId = stringValue(
    record.id
    ?? record.subscription_id
    ?? nestedSubscription?.id
    ?? (record.subscriber_id && record.follower ? record.subscriber_id : undefined),
  );
  return {
    ...(subscriptionId ? { id: subscriptionId } : {}),
    follower: { id, type, ...(name ? { name } : {}) },
  };
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function hasDirectFollowerIdentity(record: Record<string, unknown>): boolean {
  return [
    'follower_id',
    'followerId',
    'user_id',
    'userId',
    'group_id',
    'groupId',
  ].some((key) => Object.hasOwn(record, key));
}

function unsupportedContract(label: string, data: unknown): TableauError {
  return new PulseContractError(
    `Unsupported Pulse ${label} response shape`,
    boundedJson(data),
  );
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return String(value).slice(0, 800);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// -- deletes ------------------------------------------------------------------

export async function deleteMetric(session: TableauSession, metricId: string): Promise<void> {
  await deleteReq(session, `${PULSE}/metrics/${encodeURIComponent(metricId)}`);
}

export async function deleteDefinition(session: TableauSession, definitionId: string): Promise<void> {
  await deleteReq(session, `${PULSE}/definitions/${encodeURIComponent(definitionId)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
