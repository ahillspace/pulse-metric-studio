import type { PulseDefinitionSummary } from "@pulse-metric-studio/shared";

const aggregationLabels: Record<string, string> = {
  SUM: "Sum",
  AVERAGE: "Average",
  AVG: "Average",
  MIN: "Minimum",
  MAX: "Maximum",
  COUNT_DISTINCT: "Distinct count",
  USER: "Calculated value",
};

export function aggregationLabel(aggregation: string): string {
  return aggregationLabels[aggregation.replace(/^AGGREGATION_/, "")] ?? aggregation;
}

/** "Sum of Sales", or the field label alone for calculated measures. */
export function calculationLabel(summary: Pick<PulseDefinitionSummary, "aggregation" | "fieldLabel">): string {
  const aggregation = summary.aggregation.replace(/^AGGREGATION_/, "");
  return aggregation === "USER" ? summary.fieldLabel : `${aggregationLabel(aggregation)} of ${summary.fieldLabel}`;
}
