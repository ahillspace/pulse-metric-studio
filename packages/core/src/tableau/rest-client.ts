/**
 * Shared Tableau REST/Pulse HTTP client.
 *
 * Improvements over Juju (see ledger D6/D7/A13):
 * - every request carries a timeout
 * - auth rejection classified centrally; unknown 403s are NOT treated as auth expiry
 * - bounded per-identity concurrency, with 429s honored through Retry-After
 */

import { getSessionContext, getStoredConnection, isSessionCurrent, type TableauSessionContext } from './session.js';
import { parseTableauProviderError, safeTableauProviderCode, type TableauProviderErrorInfo } from './provider-error-info.js';
import { createTableauCallTrace, observedTableauFetch, finishObservedTableauResponse, logTableauEvent, tableauRetryAfterMs, withTableauRetryReason, type TableauCallTrace } from './telemetry.js';
export { parseTableauProviderError, safeTableauProviderCode, type TableauProviderErrorInfo } from './provider-error-info.js';

export interface TableauSession {
  serverUrl: string;
  siteContentUrl: string;
  siteId: string;
  userId: string;
  token: string;
  /** REST API version discovered from /api/-/serverInfo at connect time. */
  apiVersion: string;
  /** Current user's display name from their user-ID profile (fullName ?? name); best-effort. */
  userName?: string;
  /** Verified site role from the authenticated user's own profile, when available. */
  siteRole?: string;
}

/** Build a versioned API path like `/api/3.27/datasources`. */
export function apiPath(session: TableauSession, suffix: string): string {
  return `/api/${session.apiVersion}${suffix}`;
}

const AUTH_REJECTED_CODES = new Set(['401000', '401001', '401002', '401003', '403001', '403010']);

export class TableauError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodySnippet: string = '',
    public readonly kind: 'auth' | 'http' | 'network' = 'http',
    public readonly providerCode?: string,
    public readonly providerInfo?: TableauProviderErrorInfo,
  ) {
    super(message);
    this.name = 'TableauError';
  }
}

/** A successful provider payload cannot become usable by retrying the same local size limit. */
export class TableauResponseSizeError extends TableauError {
  constructor() { super('Tableau response exceeds the permitted size.', 502); }
}

export function tableauProviderErrorInfo(error: TableauError, secrets: readonly string[] = []): TableauProviderErrorInfo {
  const parsed = error.providerInfo
    ? parseTableauProviderError({ code: error.providerInfo.providerCode, summary: error.providerInfo.summary, detail: error.providerInfo.detail }, secrets)
    : parseTableauProviderError(error.bodySnippet || error.message, secrets);
  return { ...parsed, ...(safeTableauProviderCode(error.providerCode, secrets) ? { providerCode: safeTableauProviderCode(error.providerCode, secrets) } : {}) };
}

export function classifyStatus(status: number, bodyText: unknown): TableauError['kind'] {
  if (status === 401) return 'auth';
  if (status === 403) {
    const code = parseTableauProviderError(bodyText).providerCode;
    if (code && AUTH_REJECTED_CODES.has(code)) return 'auth';
    return 'http';
  }
  return 'http';
}

/** Upper bound for any Tableau response body unless a caller sets a tighter one. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

interface TableauRequestInit extends RequestInit {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Status-only operations discard irrelevant bodies without changing their confirmed outcome. */
  responseBody?: { discardOnSuccess: boolean; discardOnStatuses?: readonly number[] };
}

/**
 * Removes credentials Tableau may reflect in an error body (the session token,
 * a PAT secret) before the text reaches the UI or the log.
 */
export function redactCredentials(text: string, secrets: Array<string | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (value && value.length >= 4) redacted = redacted.split(value).join('[redacted]');
  }
  return redacted;
}

async function parseBody(resp: Response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, timeoutMs = 30_000): Promise<unknown> {
  const text = await readBoundedBody(resp, maxBytes, timeoutMs);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function requestCancelled(): TableauError {
  return new TableauError('Tableau request was cancelled.', 0, '', 'network');
}

async function awaitAuthentication(refresh: Promise<boolean>, deadline: number, signal?: AbortSignal | null): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([refresh, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TableauError('Tableau request timed out while refreshing authentication.', 0, '', 'network')), Math.max(0, deadline - Date.now()));
      abort = () => reject(requestCancelled());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer!);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Await cleanup, but never extend the request's original deadline to do it. */
async function cancelBody(cancel: () => Promise<unknown>, deadline: number, signal?: AbortSignal | null, terminate?: () => void): Promise<void> {
  let cancelled: Promise<unknown>;
  try { cancelled = cancel(); } catch { return; }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const stop = () => { finish(); terminate?.(); };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', stop, { once: true });
    void cancelled.then(finish, finish);
    if (signal?.aborted) stop();
  });
}

async function readBoundedBytes(resp: Response, maxBytes: number, timeoutMs: number, signal?: AbortSignal | null, terminate?: () => void): Promise<ArrayBuffer> {
  const expiresAt = Date.now() + timeoutMs;
  const tooLarge = () => new TableauResponseSizeError();
  if (signal?.aborted) {
    if (resp.body) await cancelBody(() => resp.body!.cancel(), expiresAt, signal, terminate);
    throw requestCancelled();
  }
  if (!resp.body) return new ArrayBuffer(0);
  if (Number(resp.headers.get('content-length')) > maxBytes) {
    await cancelBody(() => resp.body!.cancel(), expiresAt, signal, terminate);
    throw tooLarge();
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TableauError('Tableau response body timed out.', 0, '', 'network'));
    }, timeoutMs);
    abort = () => reject(requestCancelled());
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    const cancelled = signal?.aborted;
    await cancelBody(() => reader.cancel(), expiresAt, signal, terminate);
    if (cancelled) throw requestCancelled();
    if (error instanceof TableauError) throw error;
    throw new TableauError('Network error while reading the Tableau response.', 0, '', 'network');
  } finally {
    clearTimeout(timer!);
    if (abort) signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return Uint8Array.from(Buffer.concat(chunks, size)).buffer;
}

export async function readBoundedBody(resp: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  return Buffer.from(await readBoundedBytes(resp, maxBytes, timeoutMs)).toString('utf8');
}

/** Provider streams never escape their request permit; callers receive ordinary buffered responses. */
function bufferedResponse(resp: Response, body: ArrayBuffer | null): Response {
  const result = new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  for (const property of ['url', 'redirected', 'type'] as const)
    Object.defineProperty(result, property, { value: resp[property] });
  return result;
}

export async function tableauFetch(
  session: TableauSession,
  path: string,
  init: TableauRequestInit = {},
): Promise<Response> {
  const requestToken = session.token;
  const context = getSessionContext(session);
  const deadline = Date.now() + (init.timeoutMs ?? 30_000);
  const trace = createTableauCallTrace();
  let resp = await rawFetch(session, path, init, requestToken, context, deadline, true, trace);

  // Version self-healing: pods disagree about supported REST versions (some
  // report stale serverInfo values, some retire old versions). On
  // "Unknown resource" (404003) for a versioned path, retry with the next
  // known-good candidate and keep it for the rest of the session.
  if (resp.status === 404 && /^\/api\/\d+\.\d+\//.test(path)) {
    const originalVersion = path.match(/^\/api\/([^/]+)\//)![1]!;
    const candidates = KNOWN_GOOD_VERSIONS.filter((version) => version !== originalVersion);
    for (const candidate of candidates) {
      const text = await readBoundedBody(resp, init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, init.timeoutMs ?? 30_000);
      resp = new Response(text, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      if (!text.includes('404003') && !/Unknown resource/i.test(text)) break;
      const candidatePath = path.replace(/^\/api\/[^/]+\//, `/api/${candidate}/`);
      trace.retryReason = 'version';
      resp = await rawFetch(session, candidatePath, init, session.token, context, deadline, false, trace);
      if (resp.ok) {
        if (!context || (getSessionContext(session) === context && isSessionCurrent(session))) session.apiVersion = candidate;
        break;
      }
      if (resp.status !== 404) break;
    }
  }
  return resp;
}

const refreshes = new WeakMap<TableauSessionContext, Promise<boolean>>();

async function reauthenticate(session: TableauSession, rejectedToken: string, context: TableauSessionContext | null): Promise<boolean> {
  if (!context || getSessionContext(session) !== context || !isSessionCurrent(session)) return false;
  if (session.token !== rejectedToken) return true;
  const pending = refreshes.get(context);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const { patSignin } = await import('./signin.js');
      if (getSessionContext(session) !== context || !isSessionCurrent(session)) return false;
      const conn = getStoredConnection(context.connectionId);
      if (!conn || conn.serverUrl !== context.serverUrl || conn.siteContentUrl !== context.siteContentUrl) return false;
      const si = await withTableauRetryReason('authentication', () => patSignin({
        serverUrl: context.serverUrl,
        siteContentUrl: context.siteContentUrl,
        patName: conn.patName,
        patSecret: conn.patSecret,
        apiVersion: session.apiVersion,
      }));
      if (!isSessionCurrent(session) || getSessionContext(session) !== context) return false;
      // Existing request paths belong to this site and user. Never transplant identities.
      if (!si.token || si.siteId !== context.siteId || si.userId !== session.userId) return false;
      session.token = si.token;
      return true;
    } catch {
      return false;
    }
  })();
  refreshes.set(context, promise);
  try { return await promise; }
  finally { if (refreshes.get(context) === promise) refreshes.delete(context); }
}

const KNOWN_GOOD_VERSIONS = ['3.27', '3.26', '3.25', '3.24', '3.23'];

/** Most requests one Tableau identity keeps in flight at once. */
export const MAX_CONCURRENT_TABLEAU_REQUESTS = 8;
const MAX_THROTTLE_RETRIES = 4;

/** Preserve the provider minimum; callers stop locally if their deadline is earlier. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  return tableauRetryAfterMs(header, now);
}

/**
 * Tableau throttles per user and site. Every request for one identity passes
 * through one gate that bounds concurrency and, after a 429, holds all of that
 * identity's requests until Tableau permits more instead of letting each
 * caller fail or retry independently.
 */
class RequestGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private resumeAt = 0;

  async run<T>(task: () => Promise<T>, deadline: number, signal?: AbortSignal | null, telemetry?: { trace: TableauCallTrace; method: string; path: string }): Promise<T> {
    if (signal?.aborted) throw requestCancelled();
    if (this.active >= MAX_CONCURRENT_TABLEAU_REQUESTS) {
      const queuedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
        const fail = (error: TableauError) => {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
          cleanup();
          reject(error);
        };
        const timeout = setTimeout(() => {
          if (telemetry) logTableauEvent({ event: 'tableau.gate_rejected', callId: telemetry.trace.callId, attempt: telemetry.trace.attempt + 1, method: telemetry.method, path: telemetry.path, holdMs: Math.max(0, this.resumeAt - Date.now()), waitedMs: Math.max(0, Date.now() - queuedAt), remainingMs: 0, reason: 'capacity_timeout', sent: false });
          fail(new TableauError('Tableau request timed out while waiting for capacity.', 0, '', 'network'));
        }, Math.max(0, deadline - Date.now()));
        const abort = () => fail(requestCancelled());
        const wake = () => { cleanup(); resolve(); };
        this.waiting.push(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      if (signal?.aborted) throw requestCancelled();
      let waitedMs = 0;
      for (let wait = this.resumeAt - Date.now(); wait > 0; wait = this.resumeAt - Date.now()) {
        const fields = telemetry ? { callId: telemetry.trace.callId, attempt: telemetry.trace.attempt + 1, method: telemetry.method, path: telemetry.path, holdMs: wait, remainingMs: Math.max(0, deadline - Date.now()), sent: false as const } : null;
        if (this.resumeAt >= deadline) {
          if (fields) logTableauEvent({ event: 'tableau.gate_rejected', ...fields, waitedMs, reason: 'throttle_deadline' });
          throw new TableauError('Tableau is temporarily unavailable until its rate limit permits another request.', 429);
        }
        const started = Date.now();
        try { await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
          const abort = () => { cleanup(); reject(requestCancelled()); };
          const timer = setTimeout(() => { cleanup(); resolve(); }, wait);
          signal?.addEventListener('abort', abort, { once: true });
        }); } finally {
          waitedMs += Math.max(0, Date.now() - started);
          if (fields) logTableauEvent({ event: 'tableau.gate_wait', ...fields, waitedMs });
        }
      }
      if (signal?.aborted) throw requestCancelled();
      if (Date.now() >= deadline) {
        if (telemetry) logTableauEvent({ event: 'tableau.gate_rejected', callId: telemetry.trace.callId, attempt: telemetry.trace.attempt + 1, method: telemetry.method, path: telemetry.path, holdMs: 0, waitedMs, remainingMs: 0, reason: waitedMs > 0 ? 'throttle_deadline' : 'capacity_timeout', sent: false });
        throw new TableauError('Tableau request timed out while waiting for capacity.', 0, '', 'network');
      }
      return await task();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) { this.active++; next(); }
    }
  }

  pause(delayMs: number): number {
    this.resumeAt = Math.max(this.resumeAt, Date.now() + delayMs);
    return Math.max(0, this.resumeAt - Date.now());
  }
}

const gates = new Map<string, RequestGate>();

function requestGate(session: TableauSession): RequestGate {
  const key = `${session.serverUrl}\u0000${session.siteId}\u0000${session.userId}`;
  let gate = gates.get(key);
  if (!gate) gates.set(key, (gate = new RequestGate()));
  return gate;
}

/** Sends through the identity's gate; a 429 means Tableau did not process the request, so it is resent. */
async function rawFetch(
  session: TableauSession,
  path: string,
  init: TableauRequestInit = {},
  token = session.token,
  context = getSessionContext(session),
  deadline = Date.now() + (init.timeoutMs ?? 30_000),
  refreshAuthentication = false,
  trace = createTableauCallTrace(),
): Promise<Response> {
  const gate = requestGate(session);
  let authenticationAttempted = false;
  let currentToken = token;
  for (let attempt = 0; ;) {
    const result = await gate.run(async () => {
      const controller = new AbortController();
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      const terminate = () => controller.abort();
      let resp: Response | undefined;
      try {
        resp = await sendOnce(session, path, { ...init, signal, timeoutMs: Math.max(1, deadline - Date.now()) }, currentToken, context, trace, gate);
        // Refresh from conclusive headers: an optional 401 diagnostic body must not block reauthentication.
        if (resp.status === 401 && refreshAuthentication && !authenticationAttempted && currentToken) {
          finishObservedTableauResponse(resp);
          authenticationAttempted = true;
          if (Date.now() >= deadline) throw new TableauError('Tableau request timed out before authentication could refresh.', 0, '', 'network');
          const refreshed = await awaitAuthentication(reauthenticate(session, currentToken, context), deadline, signal);
          if (refreshed) {
            if (resp.body) await cancelBody(() => resp!.body!.cancel(), deadline, signal, terminate);
            currentToken = session.token;
            return { retry: 'authentication' as const };
          }
        }
        if (resp.status === 429) {
          const delay = retryAfterMs(resp.headers.get('retry-after'));
          if (attempt < MAX_THROTTLE_RETRIES && Date.now() + delay < deadline) {
            if (resp.body) await cancelBody(() => resp!.body!.cancel(), deadline, signal, terminate);
            return { retry: 'throttle' as const };
          }
        }
        const needsVersionDiagnostic = resp.status === 404 && /^\/api\/\d+\.\d+\//.test(path);
        if (!needsVersionDiagnostic && init.responseBody && ((init.responseBody.discardOnSuccess && resp.ok) || init.responseBody.discardOnStatuses?.includes(resp.status))) {
          if (resp.body) await cancelBody(() => resp!.body!.cancel(), deadline, signal, terminate);
          return { retry: false as const, response: bufferedResponse(resp, null) };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (resp.body) await cancelBody(() => resp!.body!.cancel(), deadline, signal, terminate);
          if (!resp.ok && !needsVersionDiagnostic) return { retry: false as const, response: bufferedResponse(resp, null) };
          throw new TableauError('Tableau response body timed out.', 0, '', 'network');
        }
        try {
          const bytes = await readBoundedBytes(resp, init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, remaining, signal, terminate);
          return { retry: false as const, response: bufferedResponse(resp, resp.body ? bytes : null) };
        } catch (error) {
          if (resp.ok || needsVersionDiagnostic || init.signal?.aborted) throw error;
          // Keep a confirmed HTTP rejection when its optional explanation is unreadable.
          const code = safeTableauProviderCode(resp.headers.get('validation_code'), [session.token]);
          const summary = error instanceof Error ? error.message : 'Tableau response details could not be read.';
          throw new TableauError(`${init.method ?? 'GET'} ${path} failed (${resp.status})${validationDetail(resp)}`, resp.status, '', classifyStatus(resp.status, { code }), code, { summary, ...(code ? { providerCode: code } : {}) });
        }
      } catch (error) {
        if (resp?.body && !resp.bodyUsed) await cancelBody(() => resp!.body!.cancel(), deadline, signal, terminate);
        throw error;
      } finally {
        finishObservedTableauResponse(resp);
        terminate();
      }
    }, deadline, init.signal, { trace, method: init.method ?? 'GET', path });
    if (!result.retry) return result.response;
    trace.retryReason = result.retry;
    if (result.retry === 'throttle') attempt++;
  }
}

async function sendOnce(
  session: TableauSession,
  path: string,
  init: TableauRequestInit,
  token: string,
  context: TableauSessionContext | null,
  trace: TableauCallTrace,
  gate: RequestGate,
): Promise<Response> {
  if (context && (getSessionContext(session) !== context || !isSessionCurrent(session))) {
    throw new TableauError('The Tableau connection changed. Retry from the current connection.', 401, '', 'auth');
  }
  const url = `${session.serverUrl}${path}`;
  const headers = new Headers(init.headers);
  if (!headers.has('X-Tableau-Auth') && token) headers.set('X-Tableau-Auth', token);
  // Unversioned surfaces (e.g. /api/-/pulse/*) resolve the site from this
  // header — omitting it yields 401 "Unable to authenticate user" even with
  // a valid token. Versioned paths ignore it, so always send it.
  if (!headers.has('X-Tableau-Site-Id') && session.siteId) headers.set('X-Tableau-Site-Id', session.siteId);
  const { timeoutMs = 30_000, maxResponseBytes: _maxBytes, responseBody: _bodyPolicy, ...request } = init;
  let resp: Response;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    resp = await observedTableauFetch(url, { ...request, headers, redirect: 'error', signal }, trace, fetch, (response) => {
      if (response.status !== 429) return {};
      const delay = retryAfterMs(response.headers.get('retry-after'));
      // Install the cooldown before this permit can wake an already queued caller.
      return { retryAfterMs: delay, throttleHoldMs: gate.pause(delay) };
    });
  } catch (e) {
    if (init.signal?.aborted) throw requestCancelled();
    throw new TableauError(`Network error calling ${path}: ${(e as Error).message}`, 0, '', 'network');
  }
  return resp;
}

/** Extract Pulse service validation code from response headers (e.g. 400706). */
function validationDetail(resp: Response): string {
  const vc = resp.headers.get('validation_code');
  const svc = resp.headers.get('tableau_service_name') ?? '';
  if (!vc) return '';
  return ` [${svc || 'pulse'} validation ${vc}]`;
}

/** GET expecting JSON; throws typed TableauError on failure. */
export async function getJson<T>(session: TableauSession, path: string, accept?: string, timeoutMs?: number, maxResponseBytes?: number): Promise<T> {
  const resp = await tableauFetch(session, path, { method: 'GET', headers: { Accept: accept ?? 'application/json' }, timeoutMs, maxResponseBytes });
  const body = await parseBody(resp, maxResponseBytes, timeoutMs);
  if (!resp.ok) {
    const snippet = redactCredentials(typeof body === 'string' ? body : JSON.stringify(body) ?? '', [session.token]).slice(0, 500);
    const info = parseTableauProviderError(body, [session.token]);
    throw new TableauError(
      `GET ${path} failed (${resp.status})${validationDetail(resp)}`,
      resp.status,
      snippet,
      classifyStatus(resp.status, body),
      safeTableauProviderCode(resp.headers.get('validation_code'), [session.token]) ?? info.providerCode,
      info,
    );
  }
  return body as T;
}

export async function postJson<T>(
  session: TableauSession,
  path: string,
  body: unknown,
  opts: { contentType?: string; accept?: string; method?: string; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<T> {
  const resp = await tableauFetch(session, path, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': opts.contentType ?? 'application/json',
      Accept: opts.accept ?? 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
    maxResponseBytes: opts.maxResponseBytes,
  });
  const respBody = await parseBody(resp, opts.maxResponseBytes, opts.timeoutMs);
  if (!resp.ok) {
    const snippet = redactCredentials(typeof respBody === 'string' ? respBody : JSON.stringify(respBody) ?? '', [session.token]).slice(0, 800);
    const info = parseTableauProviderError(respBody, [session.token]);
    throw new TableauError(
      `${opts.method ?? 'POST'} ${path} failed (${resp.status})${validationDetail(resp)}`,
      resp.status,
      snippet,
      classifyStatus(resp.status, respBody),
      safeTableauProviderCode(resp.headers.get('validation_code'), [session.token]) ?? info.providerCode,
      info,
    );
  }
  return respBody as T;
}

export async function deleteReq(session: TableauSession, path: string): Promise<void> {
  const resp = await tableauFetch(session, path, { method: 'DELETE', maxResponseBytes: 64 * 1024, responseBody: { discardOnSuccess: true, discardOnStatuses: [404] } });
  if (!resp.ok && resp.status !== 404) {
    const bodyText = redactCredentials(await readBoundedBody(resp, 64 * 1024, 30_000).catch(() => ''), [session.token]);
    const info = parseTableauProviderError(bodyText, [session.token]);
    throw new TableauError(`DELETE ${path} failed (${resp.status})`, resp.status, bodyText.slice(0, 500), classifyStatus(resp.status, bodyText), safeTableauProviderCode(resp.headers.get('validation_code'), [session.token]) ?? info.providerCode, info);
  }
}
