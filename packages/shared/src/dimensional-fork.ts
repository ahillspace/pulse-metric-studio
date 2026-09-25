import { z } from 'zod';

export const DIMENSIONAL_FORK_LIMITS = {
  valueCharacters: 256,
  /**
   * Distinct-member count at or below which the entire value domain is fetched
   * automatically on field select (fetch-all mode). Above it, the selector
   * defaults to search-required mode to keep the picker responsive - but the
   * user can still Load all values on demand. This is an auto-load threshold,
   * NOT a cap on how many values may be selected: a clause has no value-count
   * cap, since a user can never select more distinct values than the domain
   * holds.
   */
  valueModeThreshold: 1250,
} as const;

/**
 * Sanity ceiling on a single value fetch (a search match set or an explicit
 * Load all). This is a guard against an unbounded VDS response, not a product
 * cap: it sits far above any realistic dimension cardinality, so search and
 * Load all effectively return everything.
 */
export const DIMENSION_VALUE_FETCH_CEILING = 200_000;

/**
 * How many source metrics the legacy date-fork route packs into one plan
 * request before starting another. This is a request-batching knob (bounded
 * payload + concurrency), NOT a cap on how many metrics a user may fork - there
 * is no such cap. Tableau has no batch endpoint, so every source becomes its
 * own metric-create call regardless of how these are grouped.
 */
export const DATE_FORK_BATCH_SIZE = 20;

export interface DimensionalForkRequestV1 {
  version: 1;
  sourceMetricIds: string[];
  fieldId: string;
  selection: {
    mode: 'VALUES';
    /**
     * When true, the selected values are EXCLUDED (emits `OPERATOR_NOT_EQUAL`);
     * when false/absent they are INCLUDED (emits `OPERATOR_EQUAL`). Exclude lets
     * a user keep everything but a handful of values without listing the rest.
     */
    exclude: boolean;
    values: string[];
  };
}

export interface DimensionalForkResult {
  sourceMetricId: string;
  fieldId: string;
  valueFingerprint: string;
  status: 'created' | 'existing' | 'failed';
  creationStatus?: 'created' | 'existing' | 'unknown' | 'not_attempted';
  createdMetricId?: string;
  createdApiName?: string;
  requestedSpecification?: Record<string, unknown>;
  error?: string;
  diagnostic?: {
    message: string;
    status?: number;
    kind?: 'auth' | 'http' | 'network';
    detail?: string;
  };
  reconciliationStatus?: 'visible' | 'pending_visibility' | 'ownership_mismatch' | 'failed';
  exactMetricResolved?: boolean;
  inventoryVisible?: boolean;
  ownershipVerified?: boolean;
}

export interface DimensionalForkSummary {
  terminated?: boolean;
  notAttempted?: number;
  attempted: number;
  created: number;
  existing: number;
  failed: number;
  results: DimensionalForkResult[];
}

export interface FilterDimensionField {
  id: string;
  name: string;
  label: string;
  table?: string;
  role: 'dimension';
  dataType: 'string';
  providerReference: unknown;
}

export interface DimensionValuePage {
  fieldId: string;
  values: Array<{
    key: string;
    label: string;
    value: string;
  }>;
  /**
   * True when the provider result hit the fetch ceiling: the auto-load domain
   * exceeded {@link DIMENSIONAL_FORK_LIMITS.valueModeThreshold} (so the picker
   * should switch to search / Load all), or a search / Load all fetch reached
   * {@link DIMENSION_VALUE_FETCH_CEILING}.
   */
  truncated: boolean;
}

export interface DimensionMemberCount {
  fieldId: string;
  count: number;
}

const nonBlankIdentifier = z.string().trim().min(1).max(256);
const selectedValue = z.string().refine(
  (value) => Array.from(value).length <= DIMENSIONAL_FORK_LIMITS.valueCharacters,
  `Selected values must be at most ${DIMENSIONAL_FORK_LIMITS.valueCharacters} Unicode characters.`,
);

export const DimensionalForkRequestV1Schema = z.object({
  version: z.literal(1),
  // No upper bound on source count: Tableau has no batch fork endpoint, so each
  // source becomes its own create call regardless of how many are requested.
  sourceMetricIds: z.array(nonBlankIdentifier).min(1),
  fieldId: nonBlankIdentifier,
  selection: z.object({
    mode: z.literal('VALUES'),
    exclude: z.boolean().optional().default(false),
    // No value-count cap: a user can never select more distinct values than the
    // domain holds, so the only per-value bound is the character length.
    values: z.array(selectedValue).min(1),
  }),
}).superRefine((request, context) => {
  request.selection.values.forEach((value, index) => {
    if (!value.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection', 'values', index],
        message: 'Selected values cannot be blank.',
      });
    }
  });
});

/** Return canonical exact-key sets without changing provider spelling or case. */
export function canonicalizeDimensionalForkRequest(input: unknown): DimensionalForkRequestV1 {
  const parsed = DimensionalForkRequestV1Schema.parse(input);
  return {
    ...parsed,
    sourceMetricIds: [...new Set(parsed.sourceMetricIds)].sort(compareCanonicalStrings),
    selection: {
      mode: 'VALUES',
      exclude: parsed.selection.exclude,
      values: [...new Set(parsed.selection.values)].sort(compareCanonicalStrings),
    },
  };
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
