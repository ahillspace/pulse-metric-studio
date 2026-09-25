import { z } from 'zod';
import { GRANULARITIES } from './pulse-enums.js';
import type { CatalogField, DatasourceCatalog } from './field-catalog.js';

/**
 * LLM ops contract — the structured edit language between the chat panel and
 * the builder state. The LLM never writes payloads directly; it emits ops that
 * are validated against the catalog before application.
 *
 * Improvements over the old contract:
 * - canonical enums only (no AGGREGATION_AVG / SENTIMENT_TYPE_NEUTRAL)
 * - every op references fields by catalog id, validated server-side
 * - explicit reason strings for explainability
 */

export const AddMetricOpSchema = z.object({
  op: z.literal('ADD_METRIC'),
  fieldId: z.string(),
  aggregation: z.enum(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT_DISTINCT', 'USER']).optional(),
  timeDimensionFieldId: z.string().nullable().optional(),
  cumulative: z.boolean().optional(),
  format: z.enum(['NUMBER', 'CURRENCY', 'PERCENT']).optional(),
  sentiment: z.enum(['UP', 'DOWN', 'NONE']).optional(),
  name: z.string().max(255).optional(),
  description: z.string().max(1024).optional(),
  // Short forms match the authoring prompt; long Pulse enums are accepted too
  // and normalized by the web store.
  minGranularity: z.enum([
    'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
    'GRANULARITY_BY_DAY', 'GRANULARITY_BY_WEEK', 'GRANULARITY_BY_MONTH',
    'GRANULARITY_BY_QUARTER', 'GRANULARITY_BY_YEAR',
  ]).optional(),
  // OVER_TIME = flowing time series; LATEST = latest point-in-time snapshot
  temporality: z.enum(['OVER_TIME', 'LATEST']).optional(),
  reason: z.string().max(300).optional(),
});

export const ModifyMetricOpSchema = AddMetricOpSchema.extend({
  op: z.literal('MODIFY_METRIC'),
}).required({ fieldId: true });

const RemoveOpBase = z.object({
  fieldId: z.string(),
  reason: z.string().max(300).optional(),
});

export const RemoveMetricOpSchema = RemoveOpBase.extend({ op: z.literal('REMOVE_METRIC') });
export const AddSlicerOpSchema = RemoveOpBase.extend({ op: z.literal('ADD_SLICER') });
export const RemoveSlicerOpSchema = RemoveOpBase.extend({ op: z.literal('REMOVE_SLICER') });
export const SetDigestAudienceOpSchema = z.object({
  op: z.literal('SET_DIGEST_AUDIENCE'),
  value: z.string().min(1).max(60),
});

export const OpsSchema = z.discriminatedUnion('op', [
  AddMetricOpSchema,
  ModifyMetricOpSchema,
  RemoveMetricOpSchema,
  AddSlicerOpSchema,
  RemoveSlicerOpSchema,
  SetDigestAudienceOpSchema,
]);
export type Op = z.infer<typeof OpsSchema>;

/** Full request body sent to POST /api/llm/author. */
export interface AuthorRequest {
  datasource: { luid: string; name: string };
  userMessage: string;
  chat: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Current builder selection state (active + locked entries only). */
  selection?: Record<string, unknown>;
}

/** Validated response from the authoring service. */
export interface AuthorResponse {
  assistantMessage: string;
  ops: Op[];
  digestAudience?: string;
  provider: string;
  model: string;
  warnings: string[];
}

/** Helper: resolve an op's field against a catalog (used by web store too). */
export function resolveCatalogField(catalog: DatasourceCatalog | null, id: string): CatalogField | undefined {
  if (!catalog) return undefined;
  return (
    catalog.measures.find((f) => f.id === id) ??
    catalog.dimensions.find((f) => f.id === id) ??
    catalog.timeDimensions.find((f) => f.id === id)
  );
}
