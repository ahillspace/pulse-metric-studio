import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PulseDefinitionNode } from "@pulse-metric-studio/shared";
import { flattenMetrics, metricDisplayName, MetricRow } from "./views";
import { variantPlanForSelection, variantPreview } from "./variant-plan";

const metricId = "e1f32575-0837-4018-9912-ad1eff3f2599";
const definition: PulseDefinitionNode = {
  definitionId: "definition-sales",
  name: "Closed Won",
  description: "",
  measure: "Sales",
  aggregation: "SUM",
  timeDimension: "Closed Date",
  inventoryStatus: "complete",
  metrics: [
    {
      metricId,
      name: metricId,
      measurementPeriod: {},
      timeframeLabel: "Month to date",
      filters: [],
      comparison: {},
      specification: {},
      isDefault: true,
      isScoped: false,
      scopedState: "default",
    },
  ],
};

test("inventory resolves unnamed provider metrics before variant source selection and preview", () => {
  const metrics = flattenMetrics([definition]);
  assert.equal(metrics[0].name, "Closed Won");
  const preview = variantPreview(
    metrics,
    variantPlanForSelection(metrics, [metricId]),
  );
  assert.equal(preview[0].name, "Closed Won");
  assert.equal(preview[0].id, metricId);
});

test("unavailable names never fall back to visible metric IDs", () => {
  assert.equal(
    metricDisplayName(metricId, "", metricId),
    "Metric name unavailable",
  );
  assert.equal(
    metricDisplayName("", metricId, metricId),
    "Metric name unavailable",
  );
  assert.equal(
    metricDisplayName("Regional revenue", "Sales", metricId),
    "Regional revenue",
  );
});

test("metric row displays a business name and preserves Copy ID without printing the ID", () => {
  const metrics = flattenMetrics([definition]);
  const html = renderToStaticMarkup(
    <MetricRow
      definition={definition}
      variant={definition.metrics[0]}
      metric={metrics[0]}
      selectedMetricIds={[]}
      allMetrics={metrics}
      highlighted={false}
      onSelectionChange={() => {}}
      onToggleTimeframeFamily={() => {}}
      onPreview={() => {}}
    />,
  );
  const visibleText = html.replace(/<[^>]*>/g, "");
  assert.match(visibleText, /Closed Won/);
  assert.match(visibleText, /Copy ID/);
  assert.match(html, /aria-label="Preview Closed Won"/);
  assert.doesNotMatch(visibleText, new RegExp(metricId));
});
