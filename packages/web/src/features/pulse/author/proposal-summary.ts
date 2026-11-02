import type {
  PulseMetricDraft,
  PulseWorkspaceDocumentV1,
} from "@pulse-metric-studio/shared";

const configurationProperties: Array<keyof PulseMetricDraft> = [
  "name",
  "description",
  "aggregation",
  "format",
  "sentiment",
  "temporality",
  "cumulative",
  "timeDimensionFieldId",
  "minGranularity",
];

export type ProposalSummaryItem = {
  id: string;
  name: string;
  status: "Added" | "Removed" | "Changed";
};

export function summarizeProposal(
  before: PulseWorkspaceDocumentV1,
  after: PulseWorkspaceDocumentV1,
) {
  const measures: ProposalSummaryItem[] = [];
  const filters: ProposalSummaryItem[] = [];
  for (const id of new Set([
    ...Object.keys(before.metrics),
    ...Object.keys(after.metrics),
  ])) {
    const previous = before.metrics[id];
    const next = after.metrics[id];
    if (!previous?.active && !next?.active) continue;
    const status = !previous?.active
      ? "Added"
      : !next?.active
        ? "Removed"
        : configurationProperties.some(
              (property) => previous[property] !== next[property],
            )
          ? "Changed"
          : null;
    if (status)
      measures.push({
        id,
        name:
          (next?.active ? next : previous).name ||
          (next ?? previous).fieldLabel,
        status,
      });
  }
  for (const id of new Set([
    ...Object.keys(before.slicers),
    ...Object.keys(after.slicers),
  ])) {
    const previous = before.slicers[id];
    const next = after.slicers[id];
    if (Boolean(previous?.active) === Boolean(next?.active)) continue;
    filters.push({
      id,
      name: (next ?? previous).fieldLabel,
      status: next?.active ? "Added" : "Removed",
    });
  }
  return { measures, filters };
}
