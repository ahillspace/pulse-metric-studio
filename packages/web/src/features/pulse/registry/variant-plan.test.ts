import assert from "node:assert/strict";
import test from "node:test";
import { sharedSourceFilter, stagedValues } from "./source-filters";
import {
  variantHasChanges,
  variantPlanForSelection,
  variantRequest,
  variantPreview,
} from "./variant-plan";
const metrics = ["one", "two", "three"].map((metricId) => ({
  metricId,
  filters: [] as unknown[],
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

const region = { id: "region-id", name: "Region", label: "Region" };
const scoped = {
  ...metrics[0]!,
  metricId: "scoped",
  filters: [
    {
      field: "Region",
      operator: "OPERATOR_EQUAL",
      categorical_values: [{ string_value: "West" }, { string_value: "East" }],
      include_null: false,
    },
  ],
};

test("variants of a scoped metric show its filters and only send real changes", () => {
  const plan = variantPlanForSelection([scoped], ["scoped"]);
  assert.deepEqual(variantPreview([scoped], plan, [region])[0]?.filters, ["Region: East, West"]);
  assert.equal(sharedSourceFilter([scoped], "Region")?.values.join(","), "East,West");

  // Opening the inherited filter without changing it is not a change.
  plan.clauses = [
    {
      fieldId: "region-id",
      fieldLabel: "Region",
      exclude: false,
      values: stagedValues(sharedSourceFilter([scoped], "Region")!),
    },
  ];
  assert.equal(variantHasChanges(plan, [scoped], [region]), false);
  assert.deepEqual(variantRequest(plan, [scoped], [region]).clauses, []);

  // Narrowing it replaces the source filter on that field.
  plan.clauses[0]!.values = [{ key: "East", label: "East", value: "East" }];
  assert.equal(variantHasChanges(plan, [scoped], [region]), true);
  assert.deepEqual(variantRequest(plan, [scoped], [region]).clauses[0]?.selection.values, ["East"]);
  assert.deepEqual(variantPreview([scoped], plan, [region])[0]?.filters, ["Region: East"]);
});

test("sources with different filters on a field share nothing to edit", () => {
  const other = { ...scoped, metricId: "other", filters: [{ ...scoped.filters[0]!, categorical_values: [{ string_value: "East" }] }] };
  assert.equal(sharedSourceFilter([scoped, other], "Region"), undefined);
  assert.equal(sharedSourceFilter([scoped, metrics[1]!], "Region"), undefined);
});
