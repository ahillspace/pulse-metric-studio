import type { PulseVariantRequestV1 } from "@pulse-metric-studio/shared";
import {
  reconcileMetricSelection,
  type PulseForkPlanState,
  type PulseRegistryMetric,
} from "../fork-plan";

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
export function variantRequest(
  plan: PulseForkPlanState,
): PulseVariantRequestV1 {
  return {
    version: 1,
    sourceMetricIds: [...plan.selectedMetricIds],
    ...(plan.timeframe ? { timeframe: { key: plan.timeframe.key } } : {}),
    clauses: plan.clauses.map((clause) => ({
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
) {
  const selected = new Set(plan.selectedMetricIds);
  return metrics
    .filter((metric) => selected.has(metric.metricId))
    .map((metric) => ({
      id: metric.metricId,
      name: metric.name,
      sourceTimeframe: metric.timeframeLabel,
      timeframe: plan.timeframe?.label || metric.timeframeLabel,
      filters: plan.clauses.map(
        (clause) =>
          `${clause.fieldLabel}: ${clause.exclude ? "excluding " : ""}${clause.values
            .slice(0, 4)
            .map((value) => value.label)
            .join(
              ", ",
            )}${clause.values.length > 4 ? ` and ${clause.values.length - 4} more` : ""}`,
      ),
      retainsSourceFilters: Boolean(metric.filters?.length),
    }));
}
