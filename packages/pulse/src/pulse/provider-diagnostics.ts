import { TableauError } from '@pulse-metric-studio/core';

const MAX_MESSAGE_CHARACTERS = 300;
const MAX_DETAIL_CHARACTERS = 800;

export interface PulseProviderDiagnostic {
  message: string;
  status?: number;
  kind?: 'auth' | 'http' | 'network';
  detail?: string;
}

export function boundedProviderDiagnostic(error: unknown): PulseProviderDiagnostic {
  const message = boundText(error instanceof Error ? error.message : String(error), MAX_MESSAGE_CHARACTERS);
  if (!(error instanceof TableauError)) return { message };
  const detail = boundText(error.bodySnippet, MAX_DETAIL_CHARACTERS);
  return {
    message,
    status: error.status,
    kind: error.kind,
    ...(detail ? { detail } : {}),
  };
}

export function diagnosticMessage(diagnostic: PulseProviderDiagnostic): string {
  return diagnostic.detail
    ? `${diagnostic.message}: ${diagnostic.detail}`
    : diagnostic.message;
}

function boundText(value: string, limit: number): string {
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}\u2026`;
}
