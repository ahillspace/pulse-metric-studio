import type { NormalizedTimeType } from '@pulse-metric-studio/shared';

/**
 * Provider type names are normalized before exact matching. This keeps
 * equivalent formatting from changing classification, without accepting a
 * non-date type because it contains "date" or "time".
 */
const TIME_TYPE_ALIASES: Readonly<Record<string, NormalizedTimeType>> = {
  DATE: 'DATE',
  DATETIME: 'DATETIME',
  DATE_TIME: 'DATETIME',
  TIMESTAMP: 'DATETIME',
};

export function normalizeProviderType(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase().replace(/[\s_-]+/g, '_');
}

/**
 * Classifies only known provider type spellings. `TIME`, `DATE_STRING`, and
 * other lookalikes remain ineligible until a captured provider contract adds
 * an explicit alias.
 */
export function classifyNormalizedTimeType(
  ...providerTypes: Array<string | null | undefined>
): NormalizedTimeType | null {
  for (const providerType of providerTypes) {
    const normalized = normalizeProviderType(providerType);
    if (normalized && normalized in TIME_TYPE_ALIASES) return TIME_TYPE_ALIASES[normalized]!;
  }
  return null;
}
