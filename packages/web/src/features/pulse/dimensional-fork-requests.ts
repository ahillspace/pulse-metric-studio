/**
 * Monotonic "latest request wins" guard for the Pulse dimensional fork loaders.
 *
 * The dimensional fork used to abort in-flight loopback requests with an
 * AbortController whenever the source/field/search selection changed. On macOS
 * (Tauri WKWebView), aborting an in-flight request on a pooled keep-alive
 * HTTP/1.1 connection to the loopback server corrupts the connection, so the
 * superseding request rejects with `TypeError: Load failed` even though the
 * server completes it with 200.
 *
 * Instead of cancelling, each request draws a monotonically increasing token
 * from a sequencer. Superseded requests complete naturally but are ignored:
 * only the latest token's resolved response (or genuine error) may update
 * state. No fetch is aborted, so WebKit's abort-on-keepalive corruption cannot
 * occur.
 */
export interface RequestSequencer {
  /** Begin a new request, invalidating every prior token. Returns the token to gate on. */
  next(): number;
  /** True only for the most recently issued token. */
  isLatest(token: number): boolean;
}

export function createRequestSequencer(): RequestSequencer {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isLatest(token: number): boolean {
      return token === latest;
    },
  };
}
