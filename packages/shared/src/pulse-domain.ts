import { resolveCatalogField } from "./ops.js";
import {
  validateTimeDimensionId,
  type CatalogField,
  type DatasourceCatalog,
} from "./field-catalog.js";
import {
  PulseWorkspaceDocumentV1Schema,
  type PulseMetricDraft,
  type PulsePublishReceipt,
  type PulseWorkspaceDocumentV1,
} from "./pulse-contracts.js";
import type { MetricSelection } from "./index.js";
import type { Op } from "./ops.js";

/** Unresolved remote effects must remain available for review and recovery. */
export function pulseReceiptHasUncertainty(
  receipt: PulsePublishReceipt,
): boolean {
  return (
    receipt.publishing ||
    receipt.items.some(
      (item) =>
        item.creationStatus === "unknown" || item.undoStatus === "unknown",
    ) ||
    receipt.follow.group.status === "unknown" ||
    receipt.follow.group.deletion?.status === "unknown" ||
    receipt.follow.membership.status === "unknown" ||
    receipt.follow.subscriptions.some(
      (subscription) => subscription.status === "unknown",
    )
  );
}

type MetricOp = Extract<Op, { op: "ADD_METRIC" | "MODIFY_METRIC" }>;
type Granularity = NonNullable<MetricOp["minGranularity"]>;
const GRANULARITY: Record<
  Granularity,
  Exclude<MetricSelection["minGranularity"], "">
> = {
  DAY: "DAY",
  WEEK: "WEEK",
  MONTH: "MONTH",
  QUARTER: "QUARTER",
  YEAR: "YEAR",
  GRANULARITY_BY_DAY: "DAY",
  GRANULARITY_BY_WEEK: "WEEK",
  GRANULARITY_BY_MONTH: "MONTH",
  GRANULARITY_BY_QUARTER: "QUARTER",
  GRANULARITY_BY_YEAR: "YEAR",
};
const EDITABLE = [
  "aggregation",
  "timeDimensionFieldId",
  "cumulative",
  "format",
  "sentiment",
  "name",
  "description",
  "minGranularity",
] as const satisfies ReadonlyArray<keyof MetricSelection>;

export function enforceMetricConstraints(
  metric: MetricSelection,
): MetricSelection {
  return metric.requiresUserAgg ||
    metric.aggregation !== "SUM" ||
    metric.format === "PERCENT" ||
    metric.temporality === "LATEST"
    ? { ...metric, cumulative: false }
    : metric;
}

export function applyMetricOperation(
  base: MetricSelection,
  op: MetricOp,
): MetricSelection {
  const locks = new Set(
    base.locks.map((key) =>
      key === "timeField" ? "timeDimensionFieldId" : key,
    ),
  );
  const patch: Partial<MetricSelection> = {};
  for (const key of EDITABLE) {
    if (locks.has(key) || op[key] === undefined) continue;
    if (key === "minGranularity")
      patch.minGranularity = GRANULARITY[op.minGranularity!];
    else Object.assign(patch, { [key]: op[key] });
  }
  return enforceMetricConstraints({
    ...base,
    ...patch,
    ...(op.op === "ADD_METRIC" ? { active: true } : {}),
  });
}

export function currentCatalogField(
  catalog: DatasourceCatalog,
  id: string,
): CatalogField | undefined {
  if (catalog.excluded.some((entry) => entry.field.id === id)) return undefined;
  const field = resolveCatalogField(catalog, id);
  return field?.exclusion ? undefined : field;
}

export function metricEligibilityIssue(
  catalog: DatasourceCatalog,
  metric: MetricSelection,
): string | undefined {
  const field = currentCatalogField(catalog, metric.fieldId);
  if (!field)
    return `"${metric.fieldLabel}" is unavailable or excluded from the current catalog. Remove this metric or choose another field.`;
  if (
    !catalog.measures.some((measure) => measure.id === field.id) &&
    metric.aggregation !== "COUNT_DISTINCT"
  ) {
    return `"${field.label}" is a dimension. Select COUNT_DISTINCT or remove this metric.`;
  }
  return undefined;
}

export function reconcileMetricWithCatalog(
  catalog: DatasourceCatalog,
  metric: MetricSelection,
): MetricSelection {
  const field = currentCatalogField(catalog, metric.fieldId);
  if (!field) return metric;
  const requiresUserAgg = Boolean(field.requiresUserAgg);
  const aggregation = requiresUserAgg
    ? "USER"
    : metric.aggregation === "USER"
      ? "SUM"
      : metric.aggregation;
  return enforceMetricConstraints({
    ...metric,
    fieldLabel: field.label,
    requiresUserAgg,
    aggregation,
  });
}

export function reconcileCatalogMetrics(
  catalog: DatasourceCatalog,
  metrics: Record<string, MetricSelection>,
): Record<string, MetricSelection> {
  return Object.fromEntries(
    Object.entries(metrics).map(([id, metric]) => [
      id,
      reconcileMetricWithCatalog(catalog, metric),
    ]),
  );
}

export function metricIsReady(
  catalog: DatasourceCatalog,
  metric: MetricSelection,
): boolean {
  return (
    metric.active &&
    !metricEligibilityIssue(catalog, metric) &&
    Boolean(metric.name.trim()) &&
    validateTimeDimensionId(catalog, metric.timeDimensionFieldId).eligible
  );
}

export function defaultMetricSelection(
  catalog: DatasourceCatalog,
  fieldId: string,
): MetricSelection | null {
  const field = catalog.measures.find((f) => f.id === fieldId);
  if (!field) return null;
  return {
    active: true,
    fieldId,
    fieldLabel: field.label,
    requiresUserAgg: field.requiresUserAgg,
    aggregation: "SUM",
    cumulative: false,
    format: "NUMBER",
    sentiment: "NONE",
    name: field.label,
    description: "",
    timeDimensionFieldId: catalog.timeDimensions[0]?.id ?? null,
    minGranularity: "DAY",
    temporality: "OVER_TIME",
    locks: [],
  };
}

export function defaultSlicerSelection(
  fieldId: string,
  label: string,
): { active: boolean; fieldId: string; fieldLabel: string } {
  return { active: true, fieldId, fieldLabel: label };
}

export function defaultPulseMetric(
  catalog: DatasourceCatalog,
  fieldId: string,
): PulseMetricDraft | null {
  const field = currentCatalogField(catalog, fieldId);
  if (!field) return null;
  const measure = catalog.measures.some((entry) => entry.id === field.id);
  return {
    active: true,
    fieldId,
    fieldLabel: field.label,
    aggregation: field.requiresUserAgg
      ? "USER"
      : measure
        ? "SUM"
        : "COUNT_DISTINCT",
    cumulative: false,
    format: "NUMBER",
    sentiment: "NONE",
    name: field.label,
    description: "",
    timeDimensionFieldId: catalog.timeDimensions[0]?.id ?? null,
    minGranularity: "DAY",
    temporality: "OVER_TIME",
    locks: [],
  };
}

export function reconcilePulseMetric(
  catalog: DatasourceCatalog,
  metric: PulseMetricDraft,
): MetricSelection {
  return reconcileMetricWithCatalog(catalog, {
    ...metric,
    aggregation: metric.aggregation === "AVG" ? "AVERAGE" : metric.aggregation,
    requiresUserAgg: false,
  });
}

export function validatePulseDocument(
  document: PulseWorkspaceDocumentV1,
  catalog: DatasourceCatalog,
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const active = Object.values(document.metrics).filter(
    (metric) => metric.active,
  );
  if (!active.length)
    issues.push({
      field: "",
      message: "Select at least one measure to publish.",
    });
  const activeSlicers = Object.values(document.slicers).filter(
    (slicer) => slicer.active,
  );
  if (
    !activeSlicers.some((slicer) =>
      catalog.dimensions.some((field) => field.id === slicer.fieldId),
    )
  )
    issues.push({
      field: "slicers",
      message: "Select at least one valid slicer dimension before publishing.",
    });
  for (const metric of active) {
    const issue = metricEligibilityIssue(
      catalog,
      reconcilePulseMetric(catalog, metric),
    );
    if (issue) issues.push({ field: metric.fieldId, message: issue });
    if (!metric.name.trim())
      issues.push({
        field: metric.fieldId,
        message: "Metric name is required.",
      });
    if (!validateTimeDimensionId(catalog, metric.timeDimensionFieldId).eligible)
      issues.push({
        field: metric.fieldId,
        message: "Choose an available date or datetime field.",
      });
  }
  for (const slicer of activeSlicers) {
    if (!catalog.dimensions.some((field) => field.id === slicer.fieldId))
      issues.push({
        field: slicer.fieldId,
        message: "Choose an available dimension for this slicer.",
      });
  }
  return issues;
}

export function applyPulseProposal(
  document: PulseWorkspaceDocumentV1,
  operations: Op[],
  catalog: DatasourceCatalog,
): PulseWorkspaceDocumentV1 {
  const next = structuredClone(document);
  for (const op of operations) {
    if (op.op === "SET_DIGEST_AUDIENCE") {
      if (!next.digestAudienceLocked) next.digestAudience = op.value;
      continue;
    }
    const field = currentCatalogField(catalog, op.fieldId);
    if (op.op === "REMOVE_METRIC") {
      const metric = Object.hasOwn(next.metrics, op.fieldId) ? next.metrics[op.fieldId] : undefined;
      if (metric && metric.locks.length === 0) metric.active = false;
    } else if (op.op === "REMOVE_SLICER") {
      if (Object.hasOwn(next.slicers, op.fieldId)) next.slicers[op.fieldId]!.active = false;
    } else if (op.op === "ADD_SLICER") {
      if (
        field &&
        catalog.dimensions.some((candidate) => candidate.id === field.id)
      )
        Object.defineProperty(next.slicers, field.id, {
          value: defaultSlicerSelection(field.id, field.label),
          enumerable: true, writable: true, configurable: true,
        });
    } else if (field) {
      const base =
        (Object.hasOwn(next.metrics, field.id) ? next.metrics[field.id] : undefined) ??
        (op.op === "ADD_METRIC" ? defaultPulseMetric(catalog, field.id) : null);
      if (!base) continue;
      const applied = applyMetricOperation(
        reconcilePulseMetric(catalog, base),
        op,
      );
      if (metricEligibilityIssue(catalog, applied)) continue;
      if (
        applied.timeDimensionFieldId &&
        !validateTimeDimensionId(catalog, applied.timeDimensionFieldId).eligible
      )
        continue;
      Object.defineProperty(next.metrics, field.id, {
        value: applied,
        enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return PulseWorkspaceDocumentV1Schema.parse(next);
}

/** Apply only changes whose base still matches, while keeping current manual constraints. */
export function mergePulseProposal(
  base: PulseWorkspaceDocumentV1,
  candidate: PulseWorkspaceDocumentV1,
  current: PulseWorkspaceDocumentV1,
  configurationCleared = false,
): { document: PulseWorkspaceDocumentV1; skipped: string[] } {
  const document = structuredClone(current);
  const skipped: string[] = [];
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const kind of ["metrics", "slicers"] as const) {
    for (const [id, suggested] of Object.entries(candidate[kind])) {
      const before = Object.hasOwn(base[kind], id) ? base[kind][id] : undefined;
      const now = Object.hasOwn(current[kind], id) ? current[kind][id] : undefined;
      if (equal(before, suggested)) continue;
      if (configurationCleared || (before && !now)) {
        skipped.push(`${kind}.${id}`);
        continue;
      }
      if (!before) {
        if (!now)
          Object.defineProperty(document[kind], id, {
            value: structuredClone(suggested),
            enumerable: true, writable: true, configurable: true,
          });
        else if (!equal(now, suggested)) skipped.push(`${kind}.${id}`);
        continue;
      }
      if (!now) continue;
      const beforeValues: Record<string, unknown> = { ...before };
      const currentValues: Record<string, unknown> = { ...now };
      const locks =
        kind === "metrics"
          ? new Set(current.metrics[id]!.locks)
          : new Set<string>();
      for (const [key, value] of Object.entries(suggested)) {
        if (key === "locks" || equal(beforeValues[key], value)) continue;
        const protectedRemoval =
          key === "active" && value === false && locks.size > 0;
        const manuallyChanged = !equal(currentValues[key], beforeValues[key]);
        if (locks.has(key) || protectedRemoval || manuallyChanged) {
          if (!equal(currentValues[key], value))
            skipped.push(`${kind}.${id}.${key}`);
          continue;
        }
        Object.assign(document[kind][id]!, { [key]: value });
      }
      if (kind === "metrics") {
        const metric = document.metrics[id]!;
        document.metrics[id] = enforceMetricConstraints({
          ...metric,
          aggregation:
            metric.aggregation === "AVG" ? "AVERAGE" : metric.aggregation,
          requiresUserAgg: metric.aggregation === "USER",
        });
      }
    }
  }
  if (!equal(candidate.digestAudience, base.digestAudience)) {
    if (
      !current.digestAudienceLocked &&
      equal(current.digestAudience, base.digestAudience)
    )
      document.digestAudience = candidate.digestAudience;
    else if (current.digestAudience !== candidate.digestAudience)
      skipped.push("digestAudience");
  }
  // Conversation is recorded on response, independently of accepting proposed configuration.
  return { document: PulseWorkspaceDocumentV1Schema.parse(document), skipped };
}
