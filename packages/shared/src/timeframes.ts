import { GRANULARITIES, RANGES, type Granularity, type PeriodType } from './pulse-enums.js';

/**
 * Timeframe presets for forking existing metric definitions into new
 * measurement-period variants. Keys are stable API surface (used by the web
 * app); the mapping mirrors the working Pulse Metric Studio implementation.
 */

export interface TimeframeSpec {
  granularity: PeriodType;
  range: (typeof RANGES)[keyof typeof RANGES] | string;
  lastXPeriod?: { period: number; period_type: PeriodType; include_current_period: boolean };
  label: string;
}

export const TIMEFRAMES: Record<string, TimeframeSpec> = {
  TODAY: { granularity: 'GRANULARITY_BY_DAY', range: RANGES.CURRENT_PARTIAL, label: 'Today' },
  THIS_WEEK: { granularity: 'GRANULARITY_BY_WEEK', range: RANGES.CURRENT_PARTIAL, label: 'This week' },
  MONTH_TO_DATE: { granularity: 'GRANULARITY_BY_MONTH', range: RANGES.CURRENT_PARTIAL, label: 'Month to date' },
  QUARTER_TO_DATE: { granularity: 'GRANULARITY_BY_QUARTER', range: RANGES.CURRENT_PARTIAL, label: 'Quarter to date' },
  YEAR_TO_DATE: { granularity: 'GRANULARITY_BY_YEAR', range: RANGES.CURRENT_PARTIAL, label: 'Year to date' },
  YESTERDAY: { granularity: 'GRANULARITY_BY_DAY', range: RANGES.LAST_COMPLETE, label: 'Yesterday' },
  LAST_WEEK: { granularity: 'GRANULARITY_BY_WEEK', range: RANGES.LAST_COMPLETE, label: 'Last week' },
  LAST_MONTH: { granularity: 'GRANULARITY_BY_MONTH', range: RANGES.LAST_COMPLETE, label: 'Last month' },
  LAST_QUARTER: { granularity: 'GRANULARITY_BY_QUARTER', range: RANGES.LAST_COMPLETE, label: 'Last quarter' },
  LAST_YEAR: { granularity: 'GRANULARITY_BY_YEAR', range: RANGES.LAST_COMPLETE, label: 'Last year' },
  LAST_7_DAYS: {
    granularity: 'GRANULARITY_BY_DAY', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 7, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 7 days',
  },
  LAST_14_DAYS: {
    granularity: 'GRANULARITY_BY_DAY', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 14, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 14 days',
  },
  LAST_30_DAYS: {
    granularity: 'GRANULARITY_BY_DAY', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 30, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 30 days',
  },
  LAST_60_DAYS: {
    granularity: 'GRANULARITY_BY_DAY', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 60, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 60 days',
  },
  LAST_90_DAYS: {
    granularity: 'GRANULARITY_BY_DAY', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 90, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: 'Last 90 days',
  },
  ONE_YEAR_IN_MONTHS: {
    // NOTE: kept verbatim from the legacy app despite the misleading name —
    // maps to one YEAR period, not twelve months.
    granularity: 'GRANULARITY_BY_MONTH', range: RANGES.BY_CONFIG,
    lastXPeriod: { period: 1, period_type: 'GRANULARITY_BY_YEAR', include_current_period: false },
    label: 'One year (by month)',
  },
};

export function customDaysTimeframe(days: number): TimeframeSpec {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new RangeError('Custom days must be an integer between 1 and 3650.');
  }
  return {
    granularity: 'GRANULARITY_BY_DAY',
    range: RANGES.BY_CONFIG,
    lastXPeriod: { period: days, period_type: 'GRANULARITY_BY_DAY', include_current_period: true },
    label: `Last ${days} days`,
  };
}

export function resolveTimeframe(key: string, customDays?: number): TimeframeSpec | null {
  if (key === 'CUSTOM_N_DAYS') {
    if (customDays === undefined) return null;
    try {
      return customDaysTimeframe(customDays);
    } catch {
      return null;
    }
  }
  return TIMEFRAMES[key] ?? null;
}

/** Decode a definition's measurement_period into a human label. */
export function timeframeLabelForMeasurementPeriod(mp: unknown): string {
  const m = (mp ?? {}) as {
    granularity?: string;
    range?: string;
    last_x_period?: { period?: number; period_type?: string; include_current_period?: boolean };
    last_x_periods?: { period?: number; period_type?: string; include_current_period?: boolean };
  };
  if (m.range === RANGES.CURRENT_PARTIAL) {
    switch (m.granularity) {
      case 'GRANULARITY_BY_DAY': return 'Today';
      case 'GRANULARITY_BY_WEEK': return 'This week';
      case 'GRANULARITY_BY_MONTH': return 'Month to date';
      case 'GRANULARITY_BY_QUARTER': return 'Quarter to date';
      case 'GRANULARITY_BY_YEAR': return 'Year to date';
    }
  }
  if (m.range === RANGES.LAST_COMPLETE) {
    switch (m.granularity) {
      case 'GRANULARITY_BY_DAY': return 'Yesterday';
      case 'GRANULARITY_BY_WEEK': return 'Last week';
      case 'GRANULARITY_BY_MONTH': return 'Last month';
      case 'GRANULARITY_BY_QUARTER': return 'Last quarter';
      case 'GRANULARITY_BY_YEAR': return 'Last year';
    }
  }
  const configuredPeriod = m.last_x_period ?? m.last_x_periods;
  if (m.range === RANGES.BY_CONFIG && configuredPeriod?.period != null) {
    const n = configuredPeriod.period;
    if (configuredPeriod.period_type === 'GRANULARITY_BY_YEAR' && n === 1) return 'One year';
    return `Last ${n} ${configuredPeriod.period_type?.endsWith('BY_YEAR') ? 'years' : configuredPeriod.period_type?.endsWith('BY_MONTH') ? 'months' : configuredPeriod.period_type?.endsWith('BY_WEEK') ? 'weeks' : 'days'}`;
  }
  return 'Default';
}

/**
 * minimumDate ("don't show me finer than X") → allowed_granularities list.
 * Mirrors mapMinimumDateToAllowedGranularities from the old builder.
 */
export function allowedGranularitiesForMinimumDate(minimumDate: string | null | undefined): Granularity[] {
  if (!minimumDate) return []; // empty array = unrestricted (verified working)
  switch (minimumDate) {
    case 'DAY': return ['GRANULARITY_BY_DAY', ...GRANULARITIES.slice(1)];
    case 'WEEK': return GRANULARITIES.slice(1);
    case 'MONTH': return GRANULARITIES.slice(2);
    case 'QUARTER': return GRANULARITIES.slice(3);
    case 'YEAR': return ['GRANULARITY_BY_YEAR'];
    default: return [...GRANULARITIES];
  }
}

export const MIN_GRANULARITY_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'DAY', label: 'Day' },
  { value: 'WEEK', label: 'Week' },
  { value: 'MONTH', label: 'Month' },
  { value: 'QUARTER', label: 'Quarter' },
  { value: 'YEAR', label: 'Year' },
] as const;
