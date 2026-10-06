import crypto from 'node:crypto';
import type { LlmHealthReasonCode } from '@pulse-metric-studio/shared';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  provider?: string;
  model?: string | null;
  /** The provider stopped because the response reached the output token limit. */
  truncated?: boolean;
}

export interface LlmProviderHealth {
  installed: boolean;
  configured: boolean;
  healthy: boolean | null;
  reasonCode: LlmHealthReasonCode;
  reason: string | null;
  resolvedModel: string | null;
}

/**
 * Post-completion outcome reporting bound to one provider selection. A provider
 * returning text is NOT a chat success on its own: callers that validate the
 * output (parse, repair, schema and semantic checks) must commit the outcome
 * through this tracker. Complete-and-forget usage leaves readiness untouched.
 */
export interface LlmCompletionTracker {
  /** Commit semantic success after the full validation pipeline passed. */
  commitSuccess(): void;
  /** Commit semantic failure (e.g. output could not be parsed or repaired). */
  commitFailure(reasonCode: LlmHealthReasonCode, reason: string | null): void;
}

export interface LlmProvider {
  id: string;
  label: string;
  isConfigured(): Promise<boolean>;
  getHealth?(): Promise<LlmProviderHealth>;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  /** Present when the provider was obtained through ProviderRegistry.pick(). */
  tracking?: LlmCompletionTracker;
}

export type LlmProviderErrorCode =
  | 'provider_not_installed'
  | 'provider_not_configured'
  | 'provider_authentication'
  | 'provider_quota'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_execution'
  | 'invalid_model_output'
  | 'invalid_provider_response';

export class LlmProviderError extends Error {
  readonly code: LlmProviderErrorCode;
  readonly provider: string | null;
  readonly model: string | null;
  readonly retryable: boolean;
  readonly reference: string;

  constructor(input: {
    code: LlmProviderErrorCode;
    message: string;
    provider?: string | null;
    model?: string | null;
    retryable?: boolean;
    reference?: string;
    cause?: unknown;
  }) {
    super(sanitizeProviderMessage(input.message), { cause: input.cause });
    this.name = 'LlmProviderError';
    this.code = input.code;
    this.provider = input.provider ?? null;
    this.model = input.model ?? null;
    this.retryable = input.retryable ?? false;
    this.reference = input.reference ?? `llm_${crypto.randomUUID()}`;
  }
}

export function isFallbackEligible(error: unknown): boolean {
  if (!(error instanceof LlmProviderError)) return false;
  if (error.code === 'provider_not_installed' || error.code === 'provider_not_configured') return true;
  return error.retryable && [
    'provider_quota',
    'provider_timeout',
    'provider_unavailable',
    'provider_execution',
  ].includes(error.code);
}

// Match complete quoted values, including escaped quotes, before bounding text.
// This also covers provider JSON bodies and Tableau PAT/header field spellings.
const PROVIDER_CREDENTIAL_FIELD = /(["']?(?:personal[_-]?access[_-]?token(?:[_-]?secret)?|(?:access|refresh)[_-]?token|pat(?:[_-]?secret)?|api[_-]?key|x[_-]api[_-]key|x[_-]tableau[_-]auth|authorization|token|secret|password)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;]+|[^\s,;]+)/gi;

export function sanitizeProviderMessage(message: string): string {
  return String(message)
    .replace(PROVIDER_CREDENTIAL_FIELD, (_match, prefix: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${prefix}${quote}[redacted]${quote}`;
    })
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export function extractJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {}
          break;
        }
      }
    }
  }
  throw new LlmProviderError({ code: 'invalid_model_output', message: 'Model response contained no parsable JSON object.' });
}

export function summarizeProcessError(stderr: string): string {
  const lines = sanitizeProviderMessage(stderr).split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-3).join(' ').slice(0, 300) || 'No process details are available.';
}
