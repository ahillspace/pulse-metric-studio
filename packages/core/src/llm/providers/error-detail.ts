import { sanitizeProviderMessage } from '../types.js';

const MAX_ERROR_BODY_BYTES = 16_000;
const MAX_DETAIL_LENGTH = 300;

/**
 * Reads the provider's own explanation from a failed HTTP response so users see
 * why a request was rejected (for example a deprecated parameter or unknown
 * model) instead of a bare status code. Gateways often nest the upstream error
 * as a JSON string inside their own envelope, so string values are re-parsed.
 * Only structured JSON error messages are used; unstructured bodies can carry
 * arbitrary server output and are dropped. The request's own credentials are
 * removed in addition to the generic credential-field redaction.
 */
export async function readProviderErrorDetail(response: Response, credentials: Array<string | undefined> = []): Promise<string | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(response));
  } catch {
    return undefined;
  }
  let detail = errorMessageFrom(body, 0);
  if (!detail) return undefined;
  for (const credential of credentials) {
    if (credential && credential.length >= 4) detail = detail.split(credential).join('[redacted]');
  }
  return sanitizeProviderMessage(detail).slice(0, MAX_DETAIL_LENGTH) || undefined;
}

export function withProviderDetail(message: string, detail: string | undefined): string {
  if (!detail) return message;
  return `${message.replace(/\.$/, '')}: ${detail}`;
}

function errorMessageFrom(value: unknown, depth: number): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return errorMessageFrom(JSON.parse(trimmed), depth + 1) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) return errorMessageFrom(value[0], depth + 1);
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ['error', 'detail', 'message', 'Message', 'error_description']) {
    const found = errorMessageFrom(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (bytes < MAX_ERROR_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_ERROR_BODY_BYTES);
}
