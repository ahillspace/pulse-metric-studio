import { z } from 'zod';

/**
 * Field catalog contract shared between server (discovery) and web (builder).
 * Produced by the VDS-first fields service.
 */

export type FieldRole = 'MEASURE' | 'DIMENSION';
export type NormalizedTimeType = 'DATE' | 'DATETIME';
export type FieldProvenance = 'vds_read_metadata' | 'vds_describe_datasource' | 'metadata_graphql';
export type FieldExclusionReason = 'table_calc' | 'blend_ref' | 'bin' | 'internal';

export interface CatalogField {
  /** Stable identity used in payloads & state keys (canonical Pulse identifier). */
  id: string;
  /** Display label, deduplicated across tables. */
  label: string;
  /** Raw field name as returned by the datasource. */
  name: string;
  /**
   * Exact Tableau field caption (no dedup suffix), for DISPLAY only.
   * Do NOT emit this in Pulse definition field references: the metric-query-service
   * resolves refs by internal id/name (e.g. `Calculation_NNN`), not caption. A prior
   * fix that emitted captions caused validation 404904 and was reverted - payloads
   * must send the raw canonical id via `pulseFieldReference`.
   */
  caption: string;
  role: FieldRole;
  /** Canonical type used by authoring and time-dimension eligibility. */
  dataType: string;
  /** Canonical time type when this field is a supported date or datetime field. */
  timeType?: NormalizedTimeType;
  /** Raw `dataType` value reported by the provider, when available. */
  providerType?: string | null;
  /** Raw `physicalType` value reported by the provider, when available. */
  physicalType?: string | null;
  /** Logical table caption the field belongs to (null = datasource-level calc). */
  table: string | null;
  /** Unmodified logical table identity reported by the provider. */
  logicalTableId?: string | null;
  /** Provider path that produced this field's metadata. */
  provenance?: FieldProvenance;
  defaultAggregation: string | null;
  formula: string | null;
  /**
   * True when the field is an aggregate calculation that cannot take a further
   * aggregation (e.g. SUM([Profit])/SUM([Sales])) — must use AGGREGATION_USER.
   */
  requiresUserAgg: boolean;
  /** Classification notes for excluded/limited fields. */
  exclusion?: FieldExclusionReason;
}

export interface CatalogParameter {
  name: string;
  parameterType: string;
  dataType: string;
}

export interface DatasourceCatalog {
  datasourceLuid: string;
  datasourceName: string;
  measures: CatalogField[];
  dimensions: CatalogField[];
  timeDimensions: CatalogField[];
  parameters: CatalogParameter[];
  /** Fields discovered but excluded from authoring, with reason. */
  excluded: Array<{ field: CatalogField; reason: NonNullable<CatalogField['exclusion']> }>;
  /** Aggregate field-classification diagnostics. This contains no datasource values. */
  diagnostics?: FieldCatalogDiagnostics;
  source: 'vds' | 'metadata' | 'cache';
  warnings: string[];
}

export interface FieldCatalogDiagnostics {
  counts: {
    discovered: number;
    measures: number;
    dimensions: number;
    timeDimensions: number;
    excluded: number;
  };
  excludedByReason: Partial<Record<FieldExclusionReason, number>>;
  timeDimensionExcludedByReason: {
    excluded: number;
    measureRole: number;
    unsupportedType: number;
  };
  suspiciousZeroTimeDimensions: boolean;
}

export type TimeDimensionIdValidation =
  | { eligible: true; field: CatalogField }
  | { eligible: false; reason: 'missing' | 'not_time_dimension' };

/** Validates a selected ID only against the normalized time-dimension collection. */
export function validateTimeDimensionId(
  catalog: Pick<DatasourceCatalog, 'timeDimensions'>,
  selectedId: string | null | undefined,
): TimeDimensionIdValidation {
  const id = selectedId?.trim();
  if (!id) return { eligible: false, reason: 'missing' };
  const field = catalog.timeDimensions.find((candidate) => candidate.id === id);
  return field ? { eligible: true, field } : { eligible: false, reason: 'not_time_dimension' };
}
