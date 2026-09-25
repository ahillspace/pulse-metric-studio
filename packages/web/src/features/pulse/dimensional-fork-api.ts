import type { DimensionMemberCount } from '@pulse-metric-studio/shared';
import { extractErrorMessage } from '../../api/client';
import type {
  PulseDimensionalForkSummary,
  PulseDimensionValuePage,
  PulseFilterDimensionField,
} from './dimensional-filter';

export interface PulseDimensionalForkOutcome {
  summary: PulseDimensionalForkSummary;
  error?: string;
}

export interface PulseCombinedForkRequestV1 {
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

export type PulseCombinedForkResultStatus =
  | 'created'
  | 'existing'
  | 'failed'
  | 'pending_visibility'
  | 'visible'
  | 'ownership_mismatch';

export interface PulseCombinedForkResult {
  sourceMetricId: string;
  status: PulseCombinedForkResultStatus;
  creationStatus?: 'created' | 'existing' | 'unknown' | 'not_attempted';
  reconciliationStatus?: 'visible' | 'pending_visibility' | 'ownership_mismatch' | 'failed';
  metricId?: string;
  error?: string;
  requestedSpecification?: unknown;
}

export interface PulseCombinedForkSummary {
  terminated?: boolean;
  notAttempted?: number;
  attempted: number;
  created: number;
  existing: number;
  failed: number;
  pendingVisibility: number;
  results: PulseCombinedForkResult[];
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // Coerce structured error bodies (e.g. an MQS validation object) to a real
    // message; a raw object would otherwise surface as "[object Object]".
    throw new Error(extractErrorMessage(data, response.status));
  }
  return data as T;
}

function sourceContextQuery(sourceMetricIds: string[]): URLSearchParams {
  const query = new URLSearchParams();
  for (const metricId of sourceMetricIds) query.append('sourceMetricId', metricId);
  return query;
}

export const pulseDimensionalForkApi = {
  fields: (sourceMetricIds: string[]) => {
    const query = sourceContextQuery(sourceMetricIds);
    return request<{ fields: PulseFilterDimensionField[] }>(`/api/pulse/dimensions?${query}`);
  },

  count: (sourceMetricIds: string[], fieldId: string) => {
    const query = sourceContextQuery(sourceMetricIds);
    return request<DimensionMemberCount>(
      `/api/pulse/dimensions/${encodeURIComponent(fieldId)}/count?${query}`,
    );
  },

  values: (sourceMetricIds: string[], fieldId: string, search: string, opts: { all?: boolean } = {}) => {
    const query = sourceContextQuery(sourceMetricIds);
    if (search) query.set('search', search);
    if (opts.all) query.set('all', '1');
    return request<PulseDimensionValuePage>(
      `/api/pulse/dimensions/${encodeURIComponent(fieldId)}/values?${query}`,
    );
  },

  fork: async (sourceMetricIds: string[], fieldId: string, values: string[], exclude = false): Promise<PulseDimensionalForkOutcome> => {
    const response = await fetch('/api/pulse/metrics/fork-dimensional', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        sourceMetricIds,
        fieldId,
        selection: { mode: 'VALUES', exclude, values },
      }),
    });
    const data: unknown = await response.json().catch(() => null);
    return decodeDimensionalForkResponse({ ok: response.ok, status: response.status }, data);
  },

  forkPlan: async (requestBody: PulseCombinedForkRequestV1): Promise<PulseCombinedForkSummary> => {
    const response = await fetch('/api/pulse/metrics/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const data: unknown = await response.json().catch(() => null);
    return decodeCombinedForkResponse({ ok: response.ok, status: response.status }, data);
  },
};

export function decodeDimensionalForkResponse(
  response: { ok: boolean; status: number },
  data: unknown,
): PulseDimensionalForkOutcome {
  if (isDimensionalForkSummary(data)) {
    const error = !response.ok && typeof data.error === 'string'
      ? data.error
      : !response.ok
        ? `Filtered fork failed (${response.status})`
        : undefined;
    return { summary: data, ...(error ? { error } : {}) };
  }
  const message = isRecord(data) && typeof data.error === 'string'
    ? data.error
    : `Request failed (${response.status})`;
  throw new Error(message);
}

function isDimensionalForkSummary(value: unknown): value is PulseDimensionalForkSummary & { error?: string } {
  if (!isRecord(value) || !Array.isArray(value.results)) return false;
  return ['attempted', 'created', 'existing', 'failed'].every((key) => Number.isInteger(value[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function decodeCombinedForkResponse(
  response: { ok: boolean; status: number },
  data: unknown,
): PulseCombinedForkSummary {
  const container = isRecord(data) && isRecord(data.summary) ? data.summary : data;
  const rawResults = isRecord(container) && Array.isArray(container.results)
    ? container.results
    : isRecord(container) && Array.isArray(container.outcomes)
      ? container.outcomes
      : null;
  if (!isRecord(container) || !rawResults) {
    const message = isRecord(data) && typeof data.error === 'string'
      ? data.error
      : `Fork request failed (${response.status})`;
    throw new Error(message);
  }

  const results = rawResults.map(normalizeCombinedForkResult);
  const attempted = integerOr(container.attempted, results.length);
  const created = integerOr(container.created, results.filter((result) => result.creationStatus === 'created').length);
  const existing = integerOr(container.existing, results.filter((result) => result.creationStatus === 'existing').length);
  const failed = integerOr(container.failed, results.filter((result) => result.status === 'failed' || result.status === 'ownership_mismatch').length);
  const pendingVisibility = integerOr(
    container.pendingVisibility ?? container.pending_visibility,
    results.filter((result) => result.reconciliationStatus === 'pending_visibility').length,
  );
  const error = typeof container.error === 'string'
    ? container.error
    : isRecord(data) && typeof data.error === 'string'
      ? data.error
      : !response.ok
        ? `Fork request failed (${response.status})`
        : undefined;

  return {
    attempted,
    ...(container.terminated === true ? { terminated: true } : {}),
    notAttempted: integerOr(container.notAttempted, results.filter((result) => result.creationStatus === 'not_attempted').length),
    created,
    existing,
    failed,
    pendingVisibility,
    results,
    ...(error ? { error } : {}),
  };
}

function normalizeCombinedForkResult(value: unknown): PulseCombinedForkResult {
  if (!isRecord(value)) {
    return { sourceMetricId: 'unknown', status: 'failed', error: 'The server returned an invalid fork result.' };
  }
  const sourceMetricId = firstString(value.sourceMetricId, value.source_metric_id, value.sourceId) ?? 'unknown';
  const metricId = firstString(
    value.metricId,
    value.createdMetricId,
    value.derivedMetricId,
    value.created_metric_id,
    value.derived_metric_id,
  );
  const diagnostic = isRecord(value.diagnostic) ? value.diagnostic : undefined;
  const error = firstString(value.error, value.message, diagnostic?.message);
  const rawStatus = firstString(value.status)?.toLowerCase();
  const reconciliationStatus = normalizeReconciliationStatus(value);
  const creationStatus = normalizeCreationStatus(rawStatus, value);
  const status = normalizeCombinedForkStatus(rawStatus, reconciliationStatus, creationStatus, error);
  return {
    sourceMetricId,
    status,
    ...(creationStatus ? { creationStatus } : {}),
    ...(reconciliationStatus ? { reconciliationStatus } : {}),
    ...(metricId ? { metricId } : {}),
    ...(error ? { error } : {}),
    ...(value.requestedSpecification !== undefined
      ? { requestedSpecification: value.requestedSpecification }
      : value.requested_specification !== undefined
        ? { requestedSpecification: value.requested_specification }
        : {}),
  };
}

function normalizeCombinedForkStatus(
  rawStatus: string | undefined,
  reconciliationStatus: PulseCombinedForkResult['reconciliationStatus'],
  creationStatus: PulseCombinedForkResult['creationStatus'],
  error: string | undefined,
): PulseCombinedForkResultStatus {
  if (reconciliationStatus === 'pending_visibility') return 'pending_visibility';
  if (reconciliationStatus === 'ownership_mismatch') return 'ownership_mismatch';
  if (reconciliationStatus === 'failed') return 'failed';
  if (reconciliationStatus === 'visible') return 'visible';
  if (rawStatus === 'created') return 'created';
  if (rawStatus === 'existing' || rawStatus === 'already_existing') return 'existing';
  if (rawStatus === 'visible') return 'visible';
  if (rawStatus === 'pending_visibility' || rawStatus === 'created_not_visible') return 'pending_visibility';
  if (rawStatus === 'ownership_mismatch') return 'ownership_mismatch';
  if (rawStatus === 'failed' || rawStatus === 'error') return 'failed';
  if (error) return 'failed';
  if (creationStatus === 'created' || creationStatus === 'existing') return creationStatus;
  return 'failed';
}

function normalizeCreationStatus(
  rawStatus: string | undefined,
  value: Record<string, unknown>,
): PulseCombinedForkResult['creationStatus'] {
  const explicit = firstString(value.creationStatus, value.creation_status)?.toLowerCase();
  if (explicit === 'created' || explicit === 'existing' || explicit === 'unknown' || explicit === 'not_attempted') return explicit;
  if (rawStatus === 'created') return 'created';
  if (rawStatus === 'existing' || rawStatus === 'already_existing') return 'existing';
  if (value.created === true || value.is_metric_created === true) return 'created';
  if (value.created === false || value.is_metric_created === false) return 'existing';
  return undefined;
}

function normalizeReconciliationStatus(
  value: Record<string, unknown>,
): PulseCombinedForkResult['reconciliationStatus'] {
  const status = firstString(value.reconciliationStatus, value.reconciliation_status)?.toLowerCase();
  if (status === 'visible'
    || status === 'pending_visibility'
    || status === 'ownership_mismatch'
    || status === 'failed') return status;
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}
