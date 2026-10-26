/**
 * Shared Tableau REST/Pulse HTTP client.
 *
 * Improvements over Juju (see ledger D6/D7/A13):
 * - every request carries a timeout
 * - auth rejection classified centrally; unknown 403s are NOT treated as auth expiry
 * - bounded per-identity concurrency, with 429s honored through Retry-After
 */

import { getSessionContext, getStoredConnection, isSessionCurrent, type TableauSessionContext } from './session.js';

export interface TableauSession {
  serverUrl: string;
  siteContentUrl: string;
  siteId: string;
  userId: string;
  token: string;
  /** REST API version discovered from /api/-/serverInfo at connect time. */
  apiVersion: string;
  /** Current user's display name from `/users/current` (fullName ?? name); best-effort. */
  userName?: string;
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
  ) {
    super(message);
    this.name = 'TableauError';
  }
}

function extractJsonErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string | number }; code?: string | number };
    const c = parsed?.error?.code ?? parsed?.code;
    return c != null ? String(c) : null;
  } catch {
    return null;
  }
}

export function classifyStatus(status: number, bodyText: string): TableauError['kind'] {
  if (status === 401) return 'auth';
  if (status === 403) {
    const code = extractJsonErrorCode(bodyText);
    if (code && AUTH_REJECTED_CODES.has(code)) return 'auth';
    return 'http';
  }
  return 'http';
}

/** Upper bound for any Tableau response body unless a caller sets a tighter one. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

export async function readBoundedBody(resp: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  const tooLarge = () => new TableauError('Tableau response exceeds the permitted size.', 502);
  if (Number(resp.headers.get('content-length')) > maxBytes) {
    void resp.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TableauError('Tableau response body timed out.', 0, '', 'network'));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { clearTimeout(timer!); reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

export async function tableauFetch(
  session: TableauSession,
  path: string,
  init: RequestInit & { timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<Response> {
  const requestToken = session.token;
  const context = getSessionContext(session);
  let resp = await rawFetch(session, path, init, requestToken, context);

  // Refresh only the owning active session, sharing the refresh across callers.
  if (resp.status === 401 && requestToken) {
    const refreshed = await reauthenticate(session, requestToken, context);
    if (refreshed) resp = await rawFetch(session, path, init, session.token, context);
  }

  // Version self-healing: pods disagree about supported REST versions (some
  // report stale serverInfo values, some retire old versions). On
  // "Unknown resource" (404003) for a versioned path, retry with the next
  // known-good candidate and keep it for the rest of the session.
  if (resp.status === 404 && /^\/api\/\d+\.\d+\//.test(path)) {
    const text = await readBoundedBody(resp, init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, init.timeoutMs ?? 30_000);
    resp = new Response(text, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    if (text.includes('404003') || /Unknown resource/i.test(text)) {
      const next = nextVersionCandidate(session.apiVersion);
      if (next) {
        session.apiVersion = next;
        const newPath = path.replace(/^\/api\/[^/]+\//, `/api/${next}/`);
        resp = await rawFetch(session, newPath, init, session.token, context);
      }
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
      const si = await patSignin({
        serverUrl: context.serverUrl,
        siteContentUrl: context.siteContentUrl,
        patName: conn.patName,
        patSecret: conn.patSecret,
        apiVersion: session.apiVersion,
      });
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

function nextVersionCandidate(current: string): string | null {
  const remaining = KNOWN_GOOD_VERSIONS.filter((v) => v !== current);
  return remaining.length > 0 ? remaining[0] : null;
}

/** Most requests one Tableau identity keeps in flight at once. */
export const MAX_CONCURRENT_TABLEAU_REQUESTS = 8;
const MAX_THROTTLE_RETRIES = 4;
const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** Converts a Retry-After header (seconds or HTTP date) into a bounded delay. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? '';
  let delay = DEFAULT_RETRY_AFTER_MS;
  if (/^\d+$/.test(value)) delay = Number(value) * 1000;
  else if (value && !Number.isNaN(Date.parse(value))) delay = Math.max(0, Date.parse(value) - now);
  return Math.min(delay, MAX_RETRY_AFTER_MS);
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

  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT_TABLEAU_REQUESTS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      for (let wait = this.resumeAt - Date.now(); wait > 0; wait = this.resumeAt - Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  pause(delayMs: number): void {
    this.resumeAt = Math.max(this.resumeAt, Date.now() + delayMs);
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
  init: RequestInit & { timeoutMs?: number } = {},
  token = session.token,
  context = getSessionContext(session),
): Promise<Response> {
  const gate = requestGate(session);
  for (let attempt = 0; ; attempt++) {
    const resp = await gate.run(() => sendOnce(session, path, init, token, context));
    if (resp.status !== 429 || attempt === MAX_THROTTLE_RETRIES) return resp;
    void resp.body?.cancel().catch(() => {});
    gate.pause(retryAfterMs(resp.headers.get('retry-after')));
  }
}

async function sendOnce(
  session: TableauSession,
  path: string,
  init: RequestInit & { timeoutMs?: number },
  token: string,
  context: TableauSessionContext | null,
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
  const timeoutMs = init.timeoutMs ?? 30_000;
  let resp: Response;
  try {
    resp = await fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
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
    throw new TableauError(
      `GET ${path} failed (${resp.status})${validationDetail(resp)}`,
      resp.status,
      snippet,
      classifyStatus(resp.status, snippet),
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
    throw new TableauError(
      `${opts.method ?? 'POST'} ${path} failed (${resp.status})${validationDetail(resp)}`,
      resp.status,
      snippet,
      classifyStatus(resp.status, snippet),
    );
  }
  return respBody as T;
}

export async function deleteReq(session: TableauSession, path: string): Promise<void> {
  const resp = await tableauFetch(session, path, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) {
    const bodyText = redactCredentials(await readBoundedBody(resp, 64 * 1024, 30_000).catch(() => ''), [session.token]);
    throw new TableauError(`DELETE ${path} failed (${resp.status})`, resp.status, bodyText.slice(0, 500), classifyStatus(resp.status, bodyText));
  }
}
