import type { PulseVariantRequestV1 } from "@pulse-metric-studio/shared";
import {
  reconcileMetricSelection,
  type PulseForkPlanState,
  type PulseRegistryMetric,
} from "../fork-plan";
import { changedClauses, effectiveFilterLabels, type VariantField } from "./source-filters";

export function variantPlanForSelection(
  metrics: PulseRegistryMetric[],
  selectedIds: string[],
): PulseForkPlanState {
  return {
    selectedMetricIds: reconcileMetricSelection(
      selectedIds,
      metrics.map((metric) => metric.metricId),
    ),
    timeframe: null,
    clauses: [],
  };
}
/** Clauses that differ from the selected sources' own filters. */
function planChanges(
  plan: PulseForkPlanState,
  metrics: PulseRegistryMetric[],
  fields: VariantField[],
) {
  const selected = new Set(plan.selectedMetricIds);
  return changedClauses(
    plan.clauses,
    metrics.filter((metric) => selected.has(metric.metricId)),
    fields,
  );
}
export function variantHasChanges(
  plan: PulseForkPlanState,
  metrics: PulseRegistryMetric[],
  fields: VariantField[],
): boolean {
  return Boolean(plan.timeframe || planChanges(plan, metrics, fields).length);
}
export function variantRequest(
  plan: PulseForkPlanState,
  metrics: PulseRegistryMetric[] = [],
  fields: VariantField[] = [],
): PulseVariantRequestV1 {
  return {
    version: 1,
    sourceMetricIds: [...plan.selectedMetricIds],
    ...(plan.timeframe ? { timeframe: { key: plan.timeframe.key } } : {}),
    clauses: planChanges(plan, metrics, fields).map((clause) => ({
      fieldId: clause.fieldId,
      selection: {
        mode: "VALUES",
        exclude: clause.exclude,
        values: clause.values.map((value) => value.value),
      },
    })),
  };
}
export function variantPreview(
  metrics: PulseRegistryMetric[],
  plan: PulseForkPlanState,
  fields: VariantField[] = [],
) {
  const selected = new Set(plan.selectedMetricIds);
  return metrics
    .filter((metric) => selected.has(metric.metricId))
    .map((metric) => ({
      id: metric.metricId,
      name: metric.name,
      sourceTimeframe: metric.timeframeLabel,
      timeframe: plan.timeframe?.label || metric.timeframeLabel,
      filters: effectiveFilterLabels(metric, plan.clauses, fields),
    }));
}
