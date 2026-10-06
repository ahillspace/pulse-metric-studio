import type {
  PulseRegistryMetric,
  StagedDimensionClause,
  StagedDimensionValue,
} from "../fork-plan";

/** A source metric's existing categorical filter, as Pulse stores it. */
export interface SourceStringFilter {
  fieldName: string;
  exclude: boolean;
  values: string[];
}

/** Field identity needed to relate staged clauses (by id) to Pulse filters (by name). */
export interface VariantField {
  id: string;
  name: string;
  label: string;
}

/**
 * Reads the categorical string filters Pulse stores on a metric. Filters with
 * other shapes are reported by field name only so they still show as scope.
 */
export type SourceFilter =
  | SourceStringFilter
  | { fieldName: string; unsupported: true };

export function sourceFilters(
  metric: Pick<PulseRegistryMetric, "filters">,
): SourceFilter[] {
  if (!Array.isArray(metric.filters)) return [];
  return metric.filters.flatMap((filter): SourceFilter[] => {
    if (!filter || typeof filter !== "object") return [];
    const record = filter as Record<string, unknown>;
    if (typeof record.field !== "string") return [];
    const values = Array.isArray(record.categorical_values)
      ? record.categorical_values.map((entry) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>).string_value
            : undefined,
        )
      : [];
    const operator = record.operator;
    if (
      (operator !== "OPERATOR_EQUAL" && operator !== "OPERATOR_NOT_EQUAL") ||
      values.length === 0 ||
      values.some((value) => typeof value !== "string")
    ) {
      return [{ fieldName: record.field, unsupported: true as const }];
    }
    return [
      {
        fieldName: record.field,
        exclude: operator === "OPERATOR_NOT_EQUAL",
        values: [...new Set(values as string[])].sort(),
      },
    ];
  });
}

function stringFilter(
  metric: Pick<PulseRegistryMetric, "filters">,
  fieldName: string,
): SourceStringFilter | undefined {
  const match = sourceFilters(metric).find(
    (filter) => filter.fieldName === fieldName,
  );
  return match && !("unsupported" in match) ? match : undefined;
}

function sameFilter(left: SourceStringFilter, right: SourceStringFilter) {
  return (
    left.exclude === right.exclude &&
    left.values.length === right.values.length &&
    left.values.every((value, index) => value === right.values[index])
  );
}

/**
 * The filter every selected source shares on a field, which the editor can
 * load for editing. Sources that disagree (or lack the filter) share nothing.
 */
export function sharedSourceFilter(
  metrics: Array<Pick<PulseRegistryMetric, "filters">>,
  fieldName: string,
): SourceStringFilter | undefined {
  if (metrics.length === 0) return undefined;
  const first = stringFilter(metrics[0]!, fieldName);
  if (!first) return undefined;
  return metrics.every((metric) => {
    const filter = stringFilter(metric, fieldName);
    return filter !== undefined && sameFilter(filter, first);
  })
    ? first
    : undefined;
}

export function stagedValues(filter: SourceStringFilter): StagedDimensionValue[] {
  return filter.values.map((value) => ({ key: value, label: value, value }));
}

/**
 * Clauses that change at least one source. A clause identical to every
 * source's existing filter would create a duplicate of the source, so it is
 * not a change and is never sent.
 */
export function changedClauses(
  clauses: StagedDimensionClause[],
  metrics: Array<Pick<PulseRegistryMetric, "filters">>,
  fields: VariantField[],
): StagedDimensionClause[] {
  const nameById = new Map(fields.map((field) => [field.id, field.name]));
  return clauses.filter((clause) => {
    const fieldName = nameById.get(clause.fieldId);
    const shared = fieldName && sharedSourceFilter(metrics, fieldName);
    if (!shared) return true;
    const staged: SourceStringFilter = {
      fieldName: shared.fieldName,
      exclude: clause.exclude,
      values: [...new Set(clause.values.map((value) => value.value))].sort(),
    };
    return !sameFilter(staged, shared);
  });
}

function summary(exclude: boolean, values: string[]) {
  const shown = values.slice(0, 4).join(", ");
  const more = values.length > 4 ? ` and ${values.length - 4} more` : "";
  return `${exclude ? "excluding " : ""}${shown}${more}`;
}

/**
 * The filters a variant of `metric` will carry: its own filters, with any
 * staged clause replacing the filter on the same field, then new fields.
 */
export function effectiveFilterLabels(
  metric: Pick<PulseRegistryMetric, "filters">,
  clauses: StagedDimensionClause[],
  fields: VariantField[],
): string[] {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const clauseByName = new Map(
    clauses.flatMap((clause) => {
      const field = byId.get(clause.fieldId);
      return field ? [[field.name, clause] as const] : [];
    }),
  );
  const labelFor = (fieldName: string) => byName.get(fieldName)?.label ?? fieldName;
  const clauseLabel = (clause: StagedDimensionClause) =>
    `${clause.fieldLabel}: ${summary(clause.exclude, clause.values.map((value) => value.label))}`;
  const labels = sourceFilters(metric).map((filter) => {
    const clause = clauseByName.get(filter.fieldName);
    if (clause) return clauseLabel(clause);
    return "unsupported" in filter
      ? labelFor(filter.fieldName)
      : `${labelFor(filter.fieldName)}: ${summary(filter.exclude, filter.values)}`;
  });
  const sourceNames = new Set(sourceFilters(metric).map((filter) => filter.fieldName));
  for (const clause of clauses) {
    const field = byId.get(clause.fieldId);
    if (!field || !sourceNames.has(field.name)) labels.push(clauseLabel(clause));
  }
  return labels;
}
