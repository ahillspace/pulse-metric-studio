export interface PulseRegistryMetric {
  metricId: string;
  definitionId: string;
  name: string;
  timeframeLabel: string;
  measurementPeriod: unknown;
  filters?: unknown[];
  comparison?: unknown;
  specification?: Record<string, unknown>;
  /** True when this is the definition's default metric (not deletable on its own). */
  isDefault?: boolean | null;
  scopedState?: 'default' | 'filtered' | 'variant' | 'unknown';
}

export interface StagedTimeframe {
  key: string;
  label: string;
  customDays?: number;
}

export interface StagedDimensionValue {
  key: string;
  label: string;
  value: string;
}

export interface StagedDimensionClause {
  fieldId: string;
  fieldLabel: string;
  table?: string;
  /** When true, the values are excluded (OPERATOR_NOT_EQUAL) rather than included. */
  exclude: boolean;
  /**
   * Total distinct members in the dimension when the clause was staged, when
   * known. UI-only (never sent to Tableau): it lets an exclude clause report the
   * count of members KEPT ("keeps 798") instead of the count dropped.
   */
  memberTotal?: number;
  values: StagedDimensionValue[];
}

export interface PulseForkPlanState {
  selectedMetricIds: string[];
  timeframe: StagedTimeframe | null;
  clauses: StagedDimensionClause[];
}

export const EMPTY_PULSE_FORK_PLAN: PulseForkPlanState = {
  selectedMetricIds: [],
  timeframe: null,
  clauses: [],
};

export function canonicalStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => String(value).trim()).filter(Boolean))]
    .sort(compareStrings);
}

export function reconcileMetricSelection(
  selectedMetricIds: Iterable<string>,
  availableMetricIds: Iterable<string>,
): string[] {
  const available = new Set(canonicalStrings(availableMetricIds));
  return canonicalStrings(selectedMetricIds).filter((metricId) => available.has(metricId));
}

export function setMetricSelection(
  selectedMetricIds: Iterable<string>,
  targetMetricIds: Iterable<string>,
  selected: boolean,
): string[] {
  const next = new Set(canonicalStrings(selectedMetricIds));
  for (const metricId of canonicalStrings(targetMetricIds)) {
    if (selected) next.add(metricId);
    else next.delete(metricId);
  }
  return canonicalStrings(next);
}

export function selectionState(
  selectedMetricIds: Iterable<string>,
  targetMetricIds: Iterable<string>,
): { checked: boolean; indeterminate: boolean; selected: number; total: number } {
  const selected = new Set(canonicalStrings(selectedMetricIds));
  const targets = canonicalStrings(targetMetricIds);
  const selectedCount = targets.filter((metricId) => selected.has(metricId)).length;
  return {
    checked: targets.length > 0 && selectedCount === targets.length,
    indeterminate: selectedCount > 0 && selectedCount < targets.length,
    selected: selectedCount,
    total: targets.length,
  };
}

export function measurementPeriodSignature(metric: Pick<PulseRegistryMetric, 'measurementPeriod' | 'timeframeLabel'>): string {
  if (metric.measurementPeriod !== null && metric.measurementPeriod !== undefined) {
    return stableJson(metric.measurementPeriod);
  }
  return `label:${metric.timeframeLabel.trim().toLocaleLowerCase()}`;
}

export function timeframeFamilyMetricIds(
  metrics: PulseRegistryMetric[],
  signature: string,
): string[] {
  return canonicalStrings(
    metrics
      .filter((metric) => measurementPeriodSignature(metric) === signature)
      .map((metric) => metric.metricId),
  );
}

/**
 * Canonical signature for a metric's dimensional scope (its filters). Two
 * metrics share a scope only when they carry the same set of dimensional
 * filters. An unfiltered (default) metric has the empty scope. Used together
 * with the timeframe signature so a bulk "select this timeframe everywhere"
 * click never sweeps up a dimension-forked sibling that merely shares the
 * timeframe.
 */
export function scopeSignature(metric: Pick<PulseRegistryMetric, 'filters'>): string {
  const filters = Array.isArray(metric.filters) ? metric.filters : [];
  return stableJson(filters);
}

/** Combined timeframe + scope signature (see {@link scopeSignature}). */
export function timeframeScopeSignature(
  metric: Pick<PulseRegistryMetric, 'measurementPeriod' | 'timeframeLabel' | 'filters'>,
): string {
  return `${measurementPeriodSignature(metric)} ${scopeSignature(metric)}`;
}

/**
 * Metric ids that share BOTH the timeframe and the dimensional scope of the
 * given signature. This is the family a timeframe-label click selects: all
 * unfiltered metrics with that timeframe, or - when the clicked metric is a
 * dimension fork - only the identically-filtered forks, never the default
 * sibling that happens to share the timeframe.
 */
export function timeframeScopeFamilyMetricIds(
  metrics: PulseRegistryMetric[],
  signature: string,
): string[] {
  return canonicalStrings(
    metrics
      .filter((metric) => timeframeScopeSignature(metric) === signature)
      .map((metric) => metric.metricId),
  );
}

/**
 * Human-readable summary of a staged clause's value part, matching Tableau's
 * "keeps"/name language:
 *   - single value:        the value's label ("East"), or "excludes East"
 *   - include, N values:   "keeps N" (exactly the members kept)
 *   - exclude, total known:"keeps <total - N>" (the members left after dropping)
 *   - exclude, total unknown: "excludes N"
 */
export function dimensionClauseSummary(clause: StagedDimensionClause): string {
  const count = clause.values.length;
  if (count === 1) {
    return clause.exclude ? `excludes ${clause.values[0].label}` : clause.values[0].label;
  }
  if (!clause.exclude) return `keeps ${count}`;
  if (typeof clause.memberTotal === 'number' && clause.memberTotal >= count) {
    return `keeps ${clause.memberTotal - count}`;
  }
  return `excludes ${count}`;
}

export function upsertDimensionClause(
  clauses: StagedDimensionClause[],
  clause: StagedDimensionClause,
): StagedDimensionClause[] {
  const normalized = normalizeClause(clause);
  return [...clauses.filter((entry) => entry.fieldId !== normalized.fieldId), normalized]
    .sort((left, right) => compareStrings(left.fieldId, right.fieldId));
}

export function removeDimensionClause(
  clauses: StagedDimensionClause[],
  fieldId: string,
): StagedDimensionClause[] {
  return clauses.filter((clause) => clause.fieldId !== fieldId);
}

export function canonicalPlanPreview(
  metrics: PulseRegistryMetric[],
  state: PulseForkPlanState,
): Array<{
  sourceMetricId: string;
  definitionId: string;
  sourceName: string;
  sourceSpecification: unknown;
  requestedChanges: {
    timeframe: StagedTimeframe | null;
    dimensionalClauses: Array<{ fieldId: string; exclude: boolean; values: string[] }>;
  };
}> {
  const selected = new Set(state.selectedMetricIds);
  const clauses = state.clauses.map(normalizeClause);
  return metrics
    .filter((metric) => selected.has(metric.metricId))
    .sort((left, right) => compareStrings(left.metricId, right.metricId))
    .map((metric) => ({
      sourceMetricId: metric.metricId,
      definitionId: metric.definitionId,
      sourceName: metric.name,
      sourceSpecification: metric.specification ?? {
        measurement_period: metric.measurementPeriod,
        filters: metric.filters ?? [],
        comparison: metric.comparison ?? null,
      },
      requestedChanges: {
        timeframe: state.timeframe,
        dimensionalClauses: clauses.map((clause) => ({
          fieldId: clause.fieldId,
          exclude: clause.exclude,
          values: clause.values.map((entry) => entry.value),
        })),
      },
    }));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizeClause(clause: StagedDimensionClause): StagedDimensionClause {
  const byKey = new Map<string, StagedDimensionValue>();
  for (const entry of clause.values) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, { ...entry });
  }
  return {
    fieldId: clause.fieldId,
    fieldLabel: clause.fieldLabel,
    ...(clause.table ? { table: clause.table } : {}),
    exclude: Boolean(clause.exclude),
    ...(typeof clause.memberTotal === 'number' ? { memberTotal: clause.memberTotal } : {}),
    values: [...byKey.values()].sort((left, right) => compareStrings(left.value, right.value)),
  };
}

function stableValue(value: unknown): unknown {
  // Sort array elements by their canonical form so a signature compares SETS,
  // not sequences: two metrics carrying the same filters (or the same
  // categorical_values) in a different order produce the same signature.
  if (Array.isArray(value)) {
    return value
      .map(stableValue)
      .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
