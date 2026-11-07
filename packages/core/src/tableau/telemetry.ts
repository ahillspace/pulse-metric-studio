import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type TableauOperation = 'inventory' | 'inventory_get_metric' | 'follow_state' | 'dimensions' | 'fork_plan' | 'get_or_create' | 'subscriptions' | 'fork_source' | 'fork_catalog' | 'fork_filter_validation' | 'dimensions_source' | 'dimensions_catalog' | 'dimensions_values';
type RetryReason = 'throttle' | 'authentication' | 'version' | 'redirect';
type LogSink = (record: Record<string, unknown>) => void;
interface TelemetryContext {
  reqId?: string;
  appMethod?: string;
  appPath?: string;
  log?: LogSink;
  operation?: TableauOperation;
  retryReason?: RetryReason;
}
const context = new AsyncLocalStorage<TelemetryContext>();
let fallback: LogSink = (record) => { process.stdout.write(`${JSON.stringify({ level: 30, time: Date.now(), ...record })}\n`); };

/** The host supplies an always-on info sink, including for work outside an HTTP request. */
export function configureTableauTelemetry(log: LogSink): void { fallback = log; }
export function runWithTableauTelemetry<T>(value: TelemetryContext, callback: () => T): T { return context.run(value, callback); }
export function withTableauOperation<T>(operation: TableauOperation, callback: () => T): T { return context.run({ ...context.getStore(), operation }, callback); }
export function withTableauRetryReason<T>(retryReason: RetryReason, callback: () => T): T { return context.run({ ...context.getStore(), retryReason }, callback); }

const operations = new Set<TableauOperation>(['inventory', 'inventory_get_metric', 'follow_state', 'dimensions', 'fork_plan', 'get_or_create', 'subscriptions', 'fork_source', 'fork_catalog', 'fork_filter_validation', 'dimensions_source', 'dimensions_catalog', 'dimensions_values']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
function safeId(value: unknown): string | null { return typeof value === 'string' && uuid.test(value) ? value : value == null ? null : '[redacted]'; }
function safeMethod(value: unknown): string { return typeof value === 'string' && methods.has(value.toUpperCase()) ? value.toUpperCase() : 'OTHER'; }

/** Only supported endpoint shapes survive; path parameters cannot expose names or filter values. */
export function safeTableauPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? '';
  if (/^\/api\/-\/serverInfo$/.test(path)) return path;
  if (/^\/api\/\d+\.\d+\/auth\/(signin|signout)$/.test(path)) return path;
  if (/^\/api\/metadata\/graphql$/.test(path)) return path;
  if (/^\/api\/-\/pulse\/(insights\/springboard|images\/metricCard)$/.test(path)) return path;
  if (/^\/api\/v1\/vizql-data-service\/(query-datasource|read-metadata|describe-datasource)$/.test(path)) return path;
  const pulse = path.match(/^(\/api\/-\/pulse\/)(definitions|metrics|subscriptions)(:getOrCreate|:batchCreate|:batchGetMetricFollowerCounts)?(?:\/([^/]+))?(\/metrics)?$/);
  if (pulse) return `${pulse[1]}${pulse[2]}${pulse[3] ?? ''}${pulse[4] ? `/${safeId(pulse[4]) ?? ':id'}` : ''}${pulse[5] ?? ''}`;
  const rest = path.match(/^(\/api\/\d+\.\d+\/sites)\/([^/]+)\/(users|groups|datasources)(?:\/([^/]+))?(\/(?:users|groups))?$/);
  if (rest) return `${rest[1]}/${safeId(rest[2])}/${rest[3]}${rest[4] ? `/${safeId(rest[4])}` : ''}${rest[5] ?? ''}`;
  return '/[redacted]';
}

/** App route templates carry no submitted values; unknown segments are removed centrally. */
export function safeTableauAppPath(value: string): string {
  const parts = value.split(/[?#]/, 1)[0]!.split('/');
  const words = new Set(['api', 'pulse', 'tableau', 'status', 'connect', 'disconnect', 'connections', 'activate', 'credential', 'credential-retirements', 'reconcile', 'datasources', 'fields', 'registry', 'definitions', 'metrics', 'existing-metrics', 'dimensions', 'values', 'count', 'fork', 'forks', 'dimensional-fork', 'dimensional-forks', 'subscriptions', 'follow-state', 'followers', 'followers-detail', 'follows', 'follow', 'unfollow', 'groups', 'users', 'inventory', 'preview', 'drafts', 'publish', 'publish-preview', 'proposals', 'receipts', 'undo', 'delete-group', 'archives', 'delete-preview', 'publication', 'runs', 'workspace', 'catalog', 'validate', 'plan', 'apply', 'delete', 'delete-plan', 'follow-targets', 'desktop', 'bootstrap', 'ready']);
  words.add('llm');
  words.add('throttle');
  return parts.map(part => !part || words.has(part) ? part : /^:[a-zA-Z][a-zA-Z0-9_]*$/.test(part) ? ':id' : uuid.test(part) ? part : '[redacted]').join('/').slice(0, 512);
}

export type TableauTelemetryEvent =
  | { event: 'tableau.attempt'; callId: string; attempt: number; method: string; path: string; status: number | null; startedAt: number; headersMs?: number; durationMs: number; retryReason?: RetryReason | null; retryAfter?: string | null; retryAfterMs?: number; throttleHoldMs?: number; failure?: 'network'; }
  | { event: 'tableau.gate_wait' | 'tableau.gate_rejected'; callId: string; attempt: number; method: string; path: string; holdMs: number; waitedMs: number; remainingMs: number; reason?: 'capacity_timeout' | 'throttle_deadline'; sent: false; }
  | { event: 'tableau.get_or_create'; metricId: string | null; isMetricCreated: boolean; }
  | { event: 'tableau.inventory' | 'tableau.inventory_listing'; metricCount: number; specificationCount: number; metricSpecificationCount?: number; usableSpecificationCount?: number; isDefaultCount: number; getMetricCount?: number; definitionId?: string; }
  | { event: 'tableau.subscriptions_page'; metricId: string; page: number; recordCount: number; hasNextPage: boolean; }
  // One line per follower-count send. splitDepth is 0 for an original batch and grows as a rejected batch is halved.
  | { event: 'tableau.follower_counts'; batchSize: number; status: number | null; providerCode?: string; splitDepth: number; }
  | { event: 'tableau.dimension_context'; cacheHit: boolean; };

/** The single serialization boundary never spreads arbitrary caller data into logs. */
export function logTableauEvent(event: TableauTelemetryEvent): void {
  if (!new Set(['tableau.attempt', 'tableau.gate_wait', 'tableau.gate_rejected', 'tableau.get_or_create', 'tableau.inventory', 'tableau.inventory_listing', 'tableau.subscriptions_page', 'tableau.follower_counts', 'tableau.dimension_context']).has(event.event)) return;
  const current = context.getStore();
  const record: Record<string, unknown> = { event: event.event };
  if (current?.reqId && /^[a-zA-Z0-9_-]{1,128}$/.test(current.reqId)) record.reqId = current.reqId;
  else record.reqId = null;
  if (current?.appMethod) record.appMethod = safeMethod(current.appMethod);
  if (current?.appPath) record.appPath = safeTableauAppPath(current.appPath);
  if (current?.operation && operations.has(current.operation)) record.operation = current.operation;
  const numbers = ['attempt', 'startedAt', 'headersMs', 'durationMs', 'retryAfterMs', 'throttleHoldMs', 'holdMs', 'waitedMs', 'remainingMs', 'metricCount', 'specificationCount', 'metricSpecificationCount', 'usableSpecificationCount', 'isDefaultCount', 'getMetricCount', 'page', 'recordCount', 'batchSize', 'splitDepth'] as const;
  const input = event as unknown as Record<string, unknown>;
  for (const key of numbers) if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) record[key] = Math.round(input[key]);
  for (const key of ['isMetricCreated', 'hasNextPage', 'cacheHit', 'sent']) if (typeof input[key] === 'boolean') record[key] = input[key];
  for (const key of ['metricId', 'definitionId']) if (key in input) record[key] = safeId(input[key]);
  if ('callId' in input) record.callId = safeId(input.callId);
  if ('method' in input) record.method = safeMethod(input.method);
  if ('path' in input) record.path = safeTableauPath(String(input.path));
  if ('status' in input) record.status = typeof input.status === 'number' && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : null;
  // Provider codes are short machine tokens; anything else could reflect provider text, so it is dropped.
  if (event.event === 'tableau.follower_counts' && typeof event.providerCode === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(event.providerCode)) record.providerCode = event.providerCode;
  if (input.reason === 'capacity_timeout' || input.reason === 'throttle_deadline') record.reason = input.reason;
  if (event.event === 'tableau.attempt') {
    record.sent = true;
    record.retryReason = ['throttle', 'authentication', 'version', 'redirect'].includes(event.retryReason ?? '') ? event.retryReason : null;
    if (event.failure === 'network') record.failure = 'network';
    if ('retryAfter' in event) {
      const value = event.retryAfter?.trim();
      // Retry-After is only a number or an HTTP date, never an arbitrary reflected header.
      record.retryAfter = !value ? null : /^\d{1,16}$/.test(value) || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? value : '[invalid]';
    }
  }
  try { (current?.log ?? fallback)(record); } catch { /* Diagnostics cannot change provider outcomes. */ }
}

/** Shared gates may wake a waiter from another request; retain its logging and tracing stores. */
export function captureTableauEventLogger(): typeof logTableauEvent {
  return AsyncLocalStorage.bind(logTableauEvent);
}

export interface TableauCallTrace { callId: string; attempt: number; retryReason?: RetryReason; }
export function createTableauCallTrace(): TableauCallTrace { return { callId: randomUUID(), attempt: 0, retryReason: context.getStore()?.retryReason }; }

export function tableauRetryAfterMs(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? '';
  let delay = 2_000;
  if (/^\d+$/.test(value)) delay = Number(value) * 1000;
  else if (value && !Number.isNaN(Date.parse(value))) delay = Math.max(0, Date.parse(value) - now);
  return Math.min(delay, Number.MAX_SAFE_INTEGER);
}

const pendingResponses = new WeakMap<Response, () => void>();

/** End an attempt after body consumption/cancellation; duplicate cleanup never duplicates a line. */
export function finishObservedTableauResponse(response?: Response): void {
  if (!response) return;
  const finish = pendingResponses.get(response);
  pendingResponses.delete(response);
  finish?.();
}

/** All Tableau dispatches pass here; the owning response lifecycle completes the attempt in finally. */
export async function observedTableauFetch(
  url: string,
  init: RequestInit,
  trace: TableauCallTrace = createTableauCallTrace(),
  fetchImpl: typeof fetch = fetch,
  onResponse?: (response: Response) => { retryAfterMs?: number; throttleHoldMs?: number },
): Promise<Response> {
  const started = performance.now();
  const startedAt = Date.now();
  const attempt = ++trace.attempt;
  const base = { event: 'tableau.attempt' as const, callId: trace.callId, attempt, method: init.method ?? 'GET', path: new URL(url).pathname, retryReason: trace.retryReason, startedAt };
  let response: Response;
  try { response = await fetchImpl(url, init); }
  catch (error) { logTableauEvent({ ...base, status: null, durationMs: performance.now() - started, failure: 'network' }); throw error; }
  const throttle = onResponse?.(response);
  const fields = { ...base, status: response.status, headersMs: performance.now() - started, ...(response.status === 429 ? { retryAfter: response.headers.get('retry-after'), retryAfterMs: tableauRetryAfterMs(response.headers.get('retry-after')), throttleHoldMs: 0, ...throttle } : {}) };
  // Keep the originating async context even when cleanup is invoked by a different continuation.
  const origin = context.getStore();
  pendingResponses.set(response, () => context.run(origin ?? {}, () => logTableauEvent({ ...fields, durationMs: performance.now() - started })));
  return response;
}
