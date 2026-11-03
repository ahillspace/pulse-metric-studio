import { sanitizeProviderMessage } from '../llm/types.js';

export interface TableauProviderErrorInfo {
  providerCode?: string;
  summary?: string;
  detail?: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? entity;
    const code = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function text(value: unknown, secrets: readonly string[], limit: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  let decoded = decodeEntities(String(value));
  for (const secret of secrets) if (secret.length >= 4) decoded = decoded.split(secret).join('[redacted]');
  return sanitizeProviderMessage(decoded).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) || undefined;
}

export function safeTableauProviderCode(value: unknown, secrets: readonly string[] = []): string | undefined {
  const code = text(value, secrets, 100);
  return code && /^[a-z0-9_.:-]{1,100}$/i.test(code) ? code : undefined;
}

/** Extract only bounded structured provider fields; never evaluate XML entities or expose arbitrary bodies. */
export function parseTableauProviderError(body: unknown, secrets: readonly string[] = []): TableauProviderErrorInfo {
  if (!body || (typeof body === 'string' && body.length > 16_000)) return {};
  let record: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const outer = parsed as Record<string, unknown>;
      record = outer.error && typeof outer.error === 'object' && !Array.isArray(outer.error) ? outer.error as Record<string, unknown>
        : typeof outer.error === 'string' ? { ...outer, summary: outer.error } : outer;
    }
  } catch {
    if (typeof body !== 'string') return {};
    if (/<!DOCTYPE|<!ENTITY/i.test(body)) return {};
    const error = body.match(/<error\b([^>]*)>([\s\S]*?)<\/error\s*>/i);
    if (!error) return {};
    const element = (name: string) => error[2]!.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'))?.[1]?.replace(/<[^>]*>/g, '');
    record = { code: error[1]!.match(/\bcode\s*=\s*(['"])(.*?)\1/i)?.[2], summary: element('summary'), detail: element('detail') };
  }
  if (!record) return {};
  const providerCode = safeTableauProviderCode(record.code ?? record.errorCode, secrets);
  const summary = text(record.summary ?? record.message, secrets, 300);
  const detail = text(record.detail ?? record.description, secrets, 500);
  return { ...(providerCode ? { providerCode } : {}), ...(summary ? { summary } : {}), ...(detail ? { detail } : {}) };
}
