import { readBoundedBody, redactCredentials, TableauError } from './rest-client.js';
import { createTableauCallTrace, observedTableauFetch, finishObservedTableauResponse } from './telemetry.js';

const MAX_SIGNIN_RESPONSE_BYTES = 1024 * 1024;

/**
 * PAT sign-in against Tableau (Cloud or on-prem). Uses JSON response parsing
 * with an XML regex fallback — the old app only did XML+regex.
 *
 * The REST API version is discovered from /api/-/serverInfo (public endpoint)
 * instead of being pinned — pods differ, and a hardcoded version 404s on
 * servers that don't support it yet.
 */

export const FALLBACK_API_VERSION = '3.27';

interface SigninResult {
  token: string;
  siteId: string;
  userId: string;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Ask the pod which REST API versions it supports. */
export async function discoverRestApiVersion(serverUrl: string): Promise<string> {
  let resp: Response | undefined;
  try {
    const signal = AbortSignal.timeout(10_000);
    const trace = createTableauCallTrace();
    let url = `${serverUrl}/api/-/serverInfo`;
    // Discovery is an uncredentialed GET. Follow its existing redirects explicitly so every hop is visible.
    for (let redirects = 0; ; redirects++) {
      resp = await observedTableauFetch(url, { headers: { Accept: 'application/json' }, signal, redirect: 'manual' }, trace);
      const location = [301, 302, 303, 307, 308].includes(resp.status) ? resp.headers.get('location') : null;
      if (!location) break;
      if (resp.body) void resp.body.cancel().catch(() => {});
      finishObservedTableauResponse(resp);
      if (redirects >= 20) return FALLBACK_API_VERSION;
      const next = new URL(location, url);
      if (!['https:', 'http:'].includes(next.protocol) || next.username || next.password) return FALLBACK_API_VERSION;
      url = next.href;
      trace.retryReason = 'redirect';
    }
    if (!resp.ok) return FALLBACK_API_VERSION;
    const data = JSON.parse(await readBoundedBody(resp, MAX_SIGNIN_RESPONSE_BYTES, 10_000)) as {
      serverInfo?: { restApiVersion?: { number?: string; legacyUrl?: string } };
    };
    const number = data?.serverInfo?.restApiVersion?.number;
    if (typeof number === 'string' && /^\d+\.\d+$/.test(number)) return number;
    const legacy = data?.serverInfo?.restApiVersion?.legacyUrl;
    const match = legacy?.match(/\/api\/(\d+\.\d+)/);
    return match ? match[1] : FALLBACK_API_VERSION;
  } catch {
    return FALLBACK_API_VERSION;
  } finally {
    finishObservedTableauResponse(resp);
  }
}

export async function patSignin(input: {
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  patSecret: string;
  apiVersion: string;
}): Promise<SigninResult> {
  const url = `${input.serverUrl}/api/${input.apiVersion}/auth/signin`;
  let resp: Response;
  try {
    resp = await observedTableauFetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        credentials: {
          personalAccessTokenName: input.patName,
          personalAccessTokenSecret: input.patSecret,
          site: { contentUrl: input.siteContentUrl ?? '' },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new TableauError(`Could not reach ${input.serverUrl}: ${(e as Error).message}`, 0, '', 'network');
  }

  try {
    if (!resp.ok) {
      const text = redactCredentials(await readBoundedBody(resp, MAX_SIGNIN_RESPONSE_BYTES, 20_000).catch(() => ''), [input.patSecret]);
      throw new TableauError(
        `Tableau rejected sign-in (${resp.status}). Check PAT name/secret and site.`,
        resp.status,
        text.slice(0, 400),
        classifySigninStatus(resp.status),
      );
    }

    const body = await parseSigninBody(resp);
    const token = body.token;
    const siteId = body.siteId;
    const userId = body.userId;
    if (!token || !siteId) throw new TableauError('Sign-in response missing token/site id', resp.status, '');
    if (!userId) throw new TableauError('Sign-in response missing user id', resp.status, '');
    return { token, siteId, userId };
  } finally { finishObservedTableauResponse(resp); }
}

async function parseSigninBody(resp: Response): Promise<{ token?: string; siteId?: string; userId?: string }> {
  const text = await readBoundedBody(resp, MAX_SIGNIN_RESPONSE_BYTES, 20_000);
  try {
    const json = JSON.parse(text) as {
      credentials?: { token?: string; site?: { id?: string }; user?: { id?: string } };
    };
    if (json?.credentials?.token) {
      return {
        token: json.credentials.token,
        siteId: json.credentials.site?.id,
        userId: json.credentials.user?.id,
      };
    }
  } catch {
    // fall through to XML
  }
  return {
    token: extractAttr(text, 'credentials', 'token') ?? undefined,
    siteId: extractAttr(text, 'site', 'id') ?? undefined,
    userId: extractAttr(text, 'user', 'id') ?? undefined,
  };
}

function classifySigninStatus(status: number): TableauError['kind'] {
  return status === 401 || status === 403 ? 'auth' : status >= 500 ? 'http' : 'auth';
}
