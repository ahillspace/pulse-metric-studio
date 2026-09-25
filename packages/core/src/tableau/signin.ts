import { TableauError } from './rest-client.js';

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
  try {
    const resp = await fetch(`${serverUrl}/api/-/serverInfo`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return FALLBACK_API_VERSION;
    const data = (await resp.json()) as {
      serverInfo?: { restApiVersion?: { number?: string; legacyUrl?: string } };
    };
    const number = data?.serverInfo?.restApiVersion?.number;
    if (typeof number === 'string' && /^\d+\.\d+$/.test(number)) return number;
    const legacy = data?.serverInfo?.restApiVersion?.legacyUrl;
    const match = legacy?.match(/\/api\/(\d+\.\d+)/);
    return match ? match[1] : FALLBACK_API_VERSION;
  } catch {
    return FALLBACK_API_VERSION;
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
    resp = await fetch(url, {
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

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
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
}

async function parseSigninBody(resp: Response): Promise<{ token?: string; siteId?: string; userId?: string }> {
  const text = await resp.text().catch(() => '');
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
