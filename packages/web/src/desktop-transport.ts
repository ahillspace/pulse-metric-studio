import { invoke, isTauri } from '@tauri-apps/api/core';

interface NativeResponse { status: number; body: string; contentType: string }

/** The desktop app uses native IPC. Browser development uses HTTP. */
export async function desktopFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!isTauri()) return fetch(input, init);
  if (init.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
  if (init.body != null && typeof init.body !== 'string') throw new TypeError('Desktop requests require a JSON string body.');
  try {
    const response = await invoke<NativeResponse>('pulse_api_request', {
      request: { method: (init.method ?? 'GET').toUpperCase(), path: input, body: init.body ?? null },
    });
    if (init.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    return new Response(response.status === 204 ? null : response.body, {
      status: response.status,
      headers: { 'Content-Type': response.contentType },
    });
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw new Error(typeof error === 'string' ? error : 'The desktop service is unavailable. Restart Pulse Metric Studio and inspect Activity before repeating a change.');
  }
}
