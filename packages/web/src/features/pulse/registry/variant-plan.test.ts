import assert from "node:assert/strict";
import test from "node:test";
import {
  variantPlanForSelection,
  variantRequest,
  variantPreview,
} from "./variant-plan";
const metrics = ["one", "two", "three"].map((metricId) => ({
  metricId,
  definitionId: "definition",
  name: metricId,
  timeframeLabel: "Month to date",
  measurementPeriod: {},
}));
test("variant dialog starts with the exact main selection, without adding siblings or defaults", () => {
  assert.deepEqual(
    variantPlanForSelection(metrics, ["two", "missing", "two"])
      .selectedMetricIds,
    ["two"],
  );
  assert.deepEqual(variantPlanForSelection(metrics, []).selectedMetricIds, []);
});
test("variant preview and request keep selected values together and one output per source", () => {
  const plan = variantPlanForSelection(metrics, ["one", "two"]);
  plan.clauses = [
    {
      fieldId: "Region",
      fieldLabel: "Region",
      exclude: true,
      values: [
        { key: "east", label: "East", value: "East" },
        { key: "west", label: "West", value: "West" },
      ],
    },
  ];
  const request = variantRequest(plan);
  assert.equal(variantPreview(metrics, plan).length, 2);
  assert.equal(request.timeframe, undefined);
  assert.deepEqual(request.clauses[0].selection, {
    mode: "VALUES",
    exclude: true,
    values: ["East", "West"],
  });
});
