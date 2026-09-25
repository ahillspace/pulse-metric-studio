import { z } from 'zod';
import { GRANULARITIES, COMPARISONS } from './pulse-enums.js';

/**
 * The exact payload Tableau Pulse expects for definition creation
 * (`POST /api/-/pulse/definitions`, content type
 * `application/vnd.tableau.metricqueryservice.v1.CreateDefinitionRequest+json`).
 * Contract recovered from the working Pulse Metric Studio implementation.
 */

export const PulseFilterSchema = z.object({
  field: z.string(),
  operator: z.string(),
  categorical_values: z.array(z.object({
    string_value: z.string().optional(),
    bool_value: z.boolean().optional(),
    null_value: z.string().nullable().optional(),
  })),
  include_null: z.boolean().optional(),
});

export const PulseBasicSpecificationSchema = z.object({
  measure: z.object({
    field: z.string(),
    aggregation: z.string(),
  }),
  time_dimension: z.object({
    field: z.string(),
  }),
  filters: z.array(PulseFilterSchema).default([]),
});

export const PulseSpecificationSchema = z.object({
  datasource: z.object({ id: z.string() }),
  basic_specification: PulseBasicSpecificationSchema,
  // Verified against successful creates on prod pods (2026-08):
  // BOTH of these live inside specification, not at the top level.
  is_running_total: z.boolean().default(false),
  temporality: z.enum(['TEMPORALITY_OVER_TIME', 'TEMPORALITY_LATEST_POINT_IN_TIME']).default('TEMPORALITY_OVER_TIME'),
});

export const PulseExtensionOptionsSchema = z.object({
  allowed_dimensions: z.array(z.string()).default([]),
  allowed_granularities: z.array(z.enum(GRANULARITIES)).default([...GRANULARITIES]),
  offset_from_today: z.number().default(0),
  use_dynamic_offset: z.boolean().default(false),
});

export const PulseRepresentationOptionsSchema = z.object({
  type: z.enum(['NUMBER_FORMAT_TYPE_NUMBER', 'NUMBER_FORMAT_TYPE_CURRENCY', 'NUMBER_FORMAT_TYPE_PERCENT']),
  sentiment_type: z.enum(['SENTIMENT_TYPE_UP_IS_GOOD', 'SENTIMENT_TYPE_DOWN_IS_GOOD', 'SENTIMENT_TYPE_NONE']),
  currency_code: z.string().optional(),
});

export const InsightSettingSchema = z.object({
  type: z.string(),
  disabled: z.boolean(),
});

/** Default insight configuration, ported verbatim from a successful create (2026-08). */
export const DEFAULT_INSIGHTS_SETTINGS = [
  { type: 'INSIGHT_TYPE_RISKY_MONOPOLY', disabled: false },
  { type: 'INSIGHT_TYPE_TOP_DRIVERS', disabled: false },
  { type: 'INSIGHT_TYPE_CURRENT_TREND', disabled: false },
  { type: 'INSIGHT_TYPE_BOTTOM_CONTRIBUTORS', disabled: false },
  { type: 'INSIGHT_TYPE_TOP_DETRACTORS', disabled: false },
  { type: 'INSIGHT_TYPE_NEW_TREND', disabled: false },
  { type: 'INSIGHT_TYPE_UNUSUAL_CHANGE', disabled: false },
  { type: 'INSIGHT_TYPE_RECORD_LEVEL_OUTLIERS', disabled: true },
  { type: 'INSIGHT_TYPE_CORRELATED_METRIC', disabled: false },
  { type: 'INSIGHT_TYPE_METRIC_FORECAST', disabled: false },
  { type: 'INSIGHT_TYPE_PACE_TO_GOAL', disabled: false },
] as const;

export const PulseInsightsOptionsSchema = z.object({
  show_insights: z.boolean().default(true),
  settings: z.array(InsightSettingSchema).default([...DEFAULT_INSIGHTS_SETTINGS]),
});

const ComparisonEntrySchema = z.object({
  compare_config: z.object({
    comparison: z.enum([
      COMPARISONS.PREVIOUS_PERIOD,
      COMPARISONS.YEAR_AGO_PERIOD,
      'TIME_COMPARISON_UNSPECIFIED',
    ]),
  }),
  index: z.number().int().optional(),
});

export const PulseComparisonsSchema = z.object({
  comparisons: z.array(ComparisonEntrySchema).default([
    { compare_config: { comparison: COMPARISONS.PREVIOUS_PERIOD }, index: 0 },
    { compare_config: { comparison: COMPARISONS.YEAR_AGO_PERIOD }, index: 1 },
  ]),
});

export const PulseDefinitionPayloadSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1024).default(''),
  specification: PulseSpecificationSchema,
  // NOTE: there is deliberately NO top-level is_running_total here — it lives
  // inside specification (verified against successful prod creates).
  extension_options: PulseExtensionOptionsSchema.default({
    allowed_dimensions: [],
    allowed_granularities: [...GRANULARITIES],
    offset_from_today: 0,
    use_dynamic_offset: false,
  }),
  representation_options: PulseRepresentationOptionsSchema,
  insights_options: PulseInsightsOptionsSchema.default({ show_insights: true, settings: [...DEFAULT_INSIGHTS_SETTINGS] }),
  comparisons: PulseComparisonsSchema.default({
    comparisons: [
      { compare_config: { comparison: COMPARISONS.PREVIOUS_PERIOD }, index: 0 },
      { compare_config: { comparison: COMPARISONS.YEAR_AGO_PERIOD }, index: 1 },
    ],
  }),
  datasource_goals: z.array(z.record(z.unknown())).default([]),
  related_links: z.array(z.record(z.unknown())).default([]),
  certification: z.object({ is_certified: z.boolean().default(false) }).default({ is_certified: false }),
  tags: z.array(z.string()).default([]),
});

export type PulseFilter = z.infer<typeof PulseFilterSchema>;
export type PulseDefinitionPayload = z.infer<typeof PulseDefinitionPayloadSchema>;

/** Response from CreateDefinitionRequest. */
export interface PulseDefinitionResponse {
  definition?: {
    metadata?: { id?: string; name?: string };
  };
}

export interface PulseMetricSummary {
  id?: string;
  metadata?: { id?: string; name?: string };
  specification?: unknown;
}
