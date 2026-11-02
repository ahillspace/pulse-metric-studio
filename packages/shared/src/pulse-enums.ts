/**
 * Canonical Tableau Pulse enums.
 *
 * Rule: the client and server speak ONLY these canonical values. The old app
 * sent non-existent enums (AGGREGATION_AVG, SENTIMENT_TYPE_NEUTRAL) from the
 * frontend and silently rewrote them server-side — that drift class is banned here.
 */

export const AGGREGATIONS = {
  SUM: 'AGGREGATION_SUM',
  AVERAGE: 'AGGREGATION_AVERAGE',
  MIN: 'MIN',
  MAX: 'MAX',
  COUNT: 'COUNT',
  COUNT_DISTINCT: 'AGGREGATION_COUNT_DISTINCT',
  USER: 'AGGREGATION_USER',
} as const;
export type Aggregation = (typeof AGGREGATIONS)[keyof typeof AGGREGATIONS];

/** UI-facing aggregation keys (canonical, no aliases). */
export const UI_AGGS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT_DISTINCT'] as const;
export type UiAgg = (typeof UI_AGGS)[number];

export function uiAggToPulse(agg: UiAgg | 'USER'): Aggregation {
  switch (agg) {
    case 'SUM': return AGGREGATIONS.SUM;
    case 'AVERAGE': return AGGREGATIONS.AVERAGE;
    case 'MIN': return AGGREGATIONS.MIN;
    case 'MAX': return AGGREGATIONS.MAX;
    case 'COUNT_DISTINCT': return AGGREGATIONS.COUNT_DISTINCT;
    case 'USER': return AGGREGATIONS.USER;
  }
}

export const NUMBER_FORMATS = {
  NUMBER: 'NUMBER_FORMAT_TYPE_NUMBER',
  CURRENCY: 'NUMBER_FORMAT_TYPE_CURRENCY',
  PERCENT: 'NUMBER_FORMAT_TYPE_PERCENT',
} as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[keyof typeof NUMBER_FORMATS];
export type UiNumberFormat = keyof typeof NUMBER_FORMATS;

export const SENTIMENTS = {
  UP_IS_GOOD: 'SENTIMENT_TYPE_UP_IS_GOOD',
  DOWN_IS_GOOD: 'SENTIMENT_TYPE_DOWN_IS_GOOD',
  NONE: 'SENTIMENT_TYPE_NONE',
} as const;
export type Sentiment = (typeof SENTIMENTS)[keyof typeof SENTIMENTS];
export type UiSentiment = 'UP' | 'DOWN' | 'NONE';

export function uiSentimentToPulse(s: UiSentiment): Sentiment {
  switch (s) {
    case 'UP': return SENTIMENTS.UP_IS_GOOD;
    case 'DOWN': return SENTIMENTS.DOWN_IS_GOOD;
    case 'NONE': return SENTIMENTS.NONE;
  }
}

export const GRANULARITIES = [
  'GRANULARITY_BY_DAY',
  'GRANULARITY_BY_WEEK',
  'GRANULARITY_BY_MONTH',
  'GRANULARITY_BY_QUARTER',
  'GRANULARITY_BY_YEAR',
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const COMPARISONS = {
  PREVIOUS_PERIOD: 'TIME_COMPARISON_PREVIOUS_PERIOD',
  YEAR_AGO_PERIOD: 'TIME_COMPARISON_YEAR_AGO_PERIOD',
} as const;

/** Measurement-period range enums used by Pulse. */
export const RANGES = {
  CURRENT_PARTIAL: 'RANGE_CURRENT_PARTIAL',
  LAST_COMPLETE: 'RANGE_LAST_COMPLETE',
  BY_CONFIG: 'RANGE_BY_CONFIG',
} as const;

export type PeriodType =
  | 'GRANULARITY_BY_DAY'
  | 'GRANULARITY_BY_WEEK'
  | 'GRANULARITY_BY_MONTH'
  | 'GRANULARITY_BY_QUARTER'
  | 'GRANULARITY_BY_YEAR';
