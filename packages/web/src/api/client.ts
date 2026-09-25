import type { AuthorResponse, DatasourceCatalog } from '@pulse-metric-studio/shared';

/**
 * Pull a human-readable message out of an error response body. The server can
 * return `error` as a bare string OR as a structured object (e.g. an MQS
 * validation error). A prior version passed the raw value to `new Error(...)`,
 * so an object surfaced in the UI as the useless string "[object Object]".
 */
export function extractErrorMessage(data: unknown, status: number): string {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const err = record?.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const nested = (err as Record<string, unknown>).message;
    if (typeof nested === 'string' && nested.trim()) return nested;
    try {
      return JSON.stringify(err);
    } catch {
      // fall through to the generic message
    }
  }
  if (typeof record?.message === 'string' && record.message.trim()) return record.message;
  return `Request failed (${status})`;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function req<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new ApiError(extractErrorMessage(data, resp.status), resp.status);
  }
  return data as T;
}

// -- tableau ------------------------------------------------------------------

export interface DraftContext {
  connectionId?: string;
  serverUrl: string;
  siteId: string;
}

export interface TableauSessionInfo {
  connectionId?: string;
  serverUrl: string;
  siteContentUrl: string;
  siteId: string;
  userId: string;
  userName?: string;
}

export interface FollowTargetInventory {
  targets: Array<{ id: string; name?: string; kind: 'GROUP' | 'USER' }>;
  errors: string[];
}

export interface ConnectionSummary {
  id: string;
  label: string;
  serverUrl: string;
  siteContentUrl: string;
  isActive: boolean;
}

export const api = {
  status: () =>
    req<{ connected: boolean; restored?: boolean; hasStoredProfile?: boolean; session?: TableauSessionInfo }>('/api/tableau/status'),
  disconnect: () => req<{ ok: true }>('/api/tableau/disconnect', 'POST'),
  connections: () => req<{ connections: ConnectionSummary[] }>('/api/tableau/connections'),
  deleteConnection: (id: string) => req<{ ok: true }>(`/api/tableau/connections/${id}`, 'DELETE'),
  activateConnection: (id: string) => req<{ ok: true }>(`/api/tableau/connections/${id}/activate`, 'POST'),

  datasources: () =>
    req<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>('/api/datasources'),
  fields: (luid: string, refresh = false) =>
    req<{ catalog: DatasourceCatalog }>(`/api/datasources/${encodeURIComponent(luid)}/fields${refresh ? '?refresh=1' : ''}`),

  // -- pulse --
  createMetrics: (input: {
    payloads: unknown[];
    withGroupFollow: boolean;
    digestAudience?: string;
    datasourceLuid: string;
    datasourceName: string;
  }) => req<CreateRunResponse>('/api/pulse/metrics/create', 'POST', input),
  runs: (datasourceLuid: string) => req<{ runs: RunReceipt[] }>(`/api/pulse/runs?datasourceLuid=${encodeURIComponent(datasourceLuid)}`),
  run: (runId: string) => req<RunReceipt>(`/api/pulse/runs/${encodeURIComponent(runId)}`),
  undoRun: (runId: string) => req<UndoRunResponse>(`/api/pulse/runs/${encodeURIComponent(runId)}/undo`, 'POST'),
  existingMetrics: (datasourceLuid: string) =>
    req<ExistingMetricsResponse>(`/api/pulse/existing-metrics?datasourceLuid=${encodeURIComponent(datasourceLuid)}`),
  followState: (metricIds: string[]) => req<FollowState>('/api/pulse/follow-state', 'POST', { metricIds }),
  groups: () => req<{ groups: Array<{ id: string; name: string }> }>('/api/pulse/groups'),
  followTargets: () => req<FollowTargetInventory>('/api/pulse/follow-targets'),
  followersDetail: (metricIds: string[]) =>
    req<{ details: FollowersDetail[] }>('/api/pulse/followers-detail', 'POST', { metricIds }),
  follow: (operations: FollowTargetOperation[]) =>
    req<{ results: FollowTargetOperationResult[] }>('/api/pulse/follow', 'POST', { operations }),
  unfollow: (operations: FollowTargetOperation[]) =>
    req<{ results: FollowTargetOperationResult[] }>('/api/pulse/unfollow', 'POST', { operations }),
  fork: (forks: Array<{ sourceMetricId: string; timeframeKey: string; customDays?: number }>) =>
    req<{ outcomes: ForkOutcome[] }>('/api/pulse/fork', 'POST', { forks }),
  deleteEntries: (entries: Array<{ definitionId?: string; metricIds: string[]; name?: string }>) =>
    req<{ definitionsDeleted: number; metricsDeleted: number; failures: string[] }>('/api/pulse/delete', 'POST', { entries }),

  // -- llm --
  llmStatus: () =>
    req<{
      providers: Record<string, { label: string; configured: boolean; available: boolean }>;
      active: string;
      models: Record<string, string | null>;
    }>('/api/llm/status'),
  setProvider: (provider: string) => req<{ ok: true }>('/api/llm/provider', 'POST', { provider }),
  author: (input: {
    catalog: DatasourceCatalog;
    chat: Array<{ role: 'user' | 'assistant'; content: string }>;
    userMessage: string;
    selection?: Record<string, unknown>;
  }) => req<AuthorResponse>('/api/llm/author', 'POST', input),

  // -- drafts --
  saveDraft: (luid: string, draft: unknown, context?: DraftContext) => req<{ ok: true }>(`/api/drafts/${encodeURIComponent(luid)}`, 'PUT', { draft, context }),
  loadDraft: (luid: string, context?: DraftContext) => req<{ draft: unknown; updatedAt: number }>(`/api/drafts/${encodeURIComponent(luid)}${context ? '?' + new URLSearchParams(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : ''}`),
  clearDraft: (luid: string) => req<{ ok: true }>(`/api/drafts/${encodeURIComponent(luid)}`, 'DELETE'),
};

export interface CreateRunResultItem {
  itemIndex?: number;
  creationStatus?: 'created' | 'not_created' | 'unknown';
  resolutionStatus?: 'pending' | 'resolved' | 'failed';
  undoStatus?: 'pending' | 'deleted' | 'failed';
  undoError?: string;
  name: string;
  status: 'created' | 'validation_failed' | 'failed';
  definitionId?: string | null;
  metricId?: string | null;
  error?: string;
  validationErrors?: string[];
}
export interface CreateRunResponse {
  publishing?: boolean;
  runId: string;
  results: CreateRunResultItem[];
  group?: { id: string; name: string; existedBefore: boolean; userAddFailed?: boolean; followedCount?: number };
  followResults?: Array<{ metricId: string; ok: boolean; error?: string }>;
  createdCount: number;
  failedCount: number;
}
export interface RunReceipt extends CreateRunResponse {
  createdAt: number;
  datasourceLuid: string;
  datasourceName: string;
}
export interface UndoRunResponse {
  definitionsDeleted: number;
  metricsDeleted: number;
  failures: string[];
  outcomes: Array<{ definitionId?: string; metricId?: string; status: 'deleted' | 'already_absent' | 'failed'; error?: string }>;
  run: RunReceipt;
}
export interface MetricVariant {
  metricId: string;
  name: string;
  measurementPeriod: unknown;
  timeframeLabel: string;
  filters?: unknown[];
  comparison?: unknown;
  specification?: Record<string, unknown>;
  isDefault?: boolean | null;
  isScoped?: boolean;
  scopedState?: 'default' | 'filtered' | 'variant' | 'unknown';
}
export interface DefinitionNode {
  definitionId: string;
  name: string;
  description: string;
  measure: string;
  aggregation: string;
  timeDimension: string;
  metrics: MetricVariant[];
  inventoryStatus?: 'complete' | 'partial' | 'unavailable';
}
export interface ExistingMetricsResponse {
  definitions: DefinitionNode[];
  totalScanned: number;
  truncated: boolean;
  failures?: Array<{
    definitionId: string;
    metricId?: string;
    stage: 'parse_definition' | 'list_metrics' | 'get_metric' | 'parse_metric';
    diagnostic: { message: string; status?: number; kind?: string; detail?: string };
  }>;
}
export interface FollowState {
  userFollowsByMetricId: Record<string, boolean>;
  groupFollowsByMetricId: Record<string, boolean>;
  /** Distinct GROUP follower ids per metric, membership-agnostic (see server). */
  groupFollowerIdsByMetricId?: Record<string, string[]>;
  /** Distinct USER follower ids per metric, membership-agnostic (see server). */
  userFollowerIdsByMetricId?: Record<string, string[]>;
  followerCountsByMetricId: Record<string, number>;
  errors: string[];
  availabilityByMetricId?: Record<string, {
    status: 'available' | 'partial' | 'unavailable';
    relationshipStatus?: 'available' | 'partial' | 'unavailable';
    followerCountStatus?: 'available' | 'unavailable';
    diagnostics?: Array<{ message: string }>;
  }>;
  groupContextUnavailable?: boolean;
}
export interface FollowersDetail {
  metricId: string;
  followers: Array<{ id: string; name: string; type: 'USER' | 'GROUP' | 'UNKNOWN' }>;
  errors: string[];
  status?: 'available' | 'partial' | 'unavailable';
  diagnostics?: Array<{ message: string }>;
}
export interface FollowTargetOperation {
  metricId: string;
  target: { id: string; kind: 'GROUP' | 'USER' };
}
export interface FollowTargetOperationResult {
  metricId: string;
  targetId: string;
  targetKind: 'GROUP' | 'USER';
  status: 'followed' | 'already_followed' | 'unfollowed' | 'not_followed' | 'failed';
  ok: boolean;
  error?: string;
}
export interface ForkOutcome {
  sourceMetricId: string;
  definitionId: string | null;
  derivedMetricId: string | null;
  created: boolean;
  creationStatus?: 'created' | 'existing';
  status: 'created' | 'existing' | 'visible' | 'pending_visibility' | 'ownership_mismatch' | 'failed';
  label: string;
  requestedSpecification?: Record<string, unknown>;
  reconciliationStatus?: 'visible' | 'pending_visibility' | 'ownership_mismatch' | 'failed';
  exactMetricResolved?: boolean;
  inventoryVisible?: boolean;
  ownershipVerified?: boolean;
  diagnostic?: { message: string; status?: number; kind?: string; detail?: string };
  error?: string;
}
