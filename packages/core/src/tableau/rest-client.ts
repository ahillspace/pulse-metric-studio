/**
 * Shared Tableau REST/Pulse HTTP client.
 *
 * Improvements over Juju (see ledger D6/D7/A13):
 * - every request carries a timeout
 * - auth rejection classified centrally; unknown 403s are NOT treated as auth expiry
 * - pagination helper for page_token style APIs
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

async function parseBody(resp: Response): Promise<unknown> {
  const text = await resp.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function tableauFetch(
  session: TableauSession,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
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
    const text = await resp.clone().text().catch(() => '');
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

async function rawFetch(
  session: TableauSession,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
  token = session.token,
  context = getSessionContext(session),
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
export async function getJson<T>(session: TableauSession, path: string, accept?: string, timeoutMs?: number): Promise<T> {
  const resp = await tableauFetch(session, path, { method: 'GET', headers: { Accept: accept ?? 'application/json' }, timeoutMs });
  const body = await parseBody(resp);
  if (!resp.ok) {
    const snippet = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500) ?? '';
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
  opts: { contentType?: string; accept?: string; method?: string; timeoutMs?: number } = {},
): Promise<T> {
  const resp = await tableauFetch(session, path, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': opts.contentType ?? 'application/json',
      Accept: opts.accept ?? 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
  });
  const respBody = await parseBody(resp);
  if (!resp.ok) {
    const snippet = typeof respBody === 'string' ? respBody.slice(0, 800) : JSON.stringify(respBody)?.slice(0, 800) ?? '';
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
    const bodyText = await resp.text().catch(() => '');
    throw new TableauError(`DELETE ${path} failed (${resp.status})`, resp.status, bodyText.slice(0, 500), classifyStatus(resp.status, bodyText));
  }
}

/** Paginate a Pulse-style API using page_token / next_page_token. */
export async function paginateToken<T>(
  session: TableauSession,
  basePath: string,
  pageSize: number,
  extract: (page: any) => T[],
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let p = `${basePath}?page_size=${pageSize}`;
    if (pageToken) p += `&page_token=${encodeURIComponent(pageToken)}`;
    const data = await getJson<any>(session, p);
    out.push(...extract(data));
    pageToken = data.next_page_token ?? null;
    if (!pageToken) break;
  }
  return out;
}
