import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress, UnsafeLlmEndpointError } from './network-policy.js';

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type Resolve = (hostname: string, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

const systemResolve: Resolve = (hostname, callback) => dns.lookup(hostname, { all: true, verbatim: true }, callback);

/**
 * A socket lookup that refuses private addresses at connect time. Checking the
 * name once and letting the request resolve it again leaves a DNS-rebinding
 * window; validating inside the connection's own lookup closes it, because the
 * address that is checked is the address the socket uses.
 */
export function publicOnlyLookup(resolve: Resolve = systemResolve, allowed: (address: string) => boolean = isPublicAddress): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    resolve(hostname, (error, addresses) => {
      if (error) return callback(error, '');
      const family = options.family === 4 || options.family === 6 ? options.family : 0;
      const candidates = family ? addresses.filter((entry) => entry.family === family) : addresses;
      if (!candidates.length || candidates.some(({ address }) => !allowed(address))) {
        return callback(Object.assign(new UnsafeLlmEndpointError('LLM endpoint resolves to a private network address.'), { code: 'EPRIVATE' }), '');
      }
      if (options.all) return callback(null, candidates);
      return callback(null, candidates[0].address, candidates[0].family);
    });
  }) as LookupFunction;
}

/** An https.Agent for SDK clients whose connections must stay on public addresses. */
export function publicOnlyAgent(): https.Agent {
  return new https.Agent({ keepAlive: true, lookup: publicOnlyLookup() });
}

/**
 * fetch-compatible client whose connections can only reach public addresses.
 * Supports what the providers use: string bodies, headers, an abort signal,
 * and redirect: 'error'. Redirects are never followed.
 */
export function guardedFetch(
  allowPrivateNetwork: boolean,
  resolve?: Resolve,
  allowed?: (address: string) => boolean,
): typeof fetch {
  if (allowPrivateNetwork) return fetch;
  const lookup = publicOnlyLookup(resolve, allowed);
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init.body != null && typeof init.body !== 'string') throw new TypeError('Guarded requests only send string bodies.');
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) throw new TypeError(`Unsupported protocol ${url.protocol}`);
    init.signal?.throwIfAborted();
    return new Promise<Response>((resolvePromise, reject) => {
      const request = transport.request(url, {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        lookup,
        signal: init.signal ?? undefined,
        agent: false,
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new TypeError('fetch failed: redirects are not followed.'));
          return;
        }
        const headers = new Headers();
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
          headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        const empty = [204, 205, 304].includes(status) || init.method === 'HEAD';
        if (empty) response.resume();
        resolvePromise(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
          status,
          statusText: response.statusMessage,
          headers,
        }));
      });
      request.on('error', (error) => reject(init.signal?.aborted ? init.signal.reason : error));
      request.end(init.body ?? undefined);
    });
  }) as typeof fetch;
}
