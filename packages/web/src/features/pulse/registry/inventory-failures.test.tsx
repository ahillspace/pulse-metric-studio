import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PulseInventoryResponse } from "@pulse-metric-studio/shared";
import { InventoryFailures } from "./InventoryFailures";

const unavailable = (definitionId: string, name: string) => ({
  definitionId,
  name,
  description: "",
  measure: "Sales",
  aggregation: "SUM",
  timeDimension: "Order Date",
  inventoryStatus: "unavailable" as const,
  metrics: [],
});

test("partial inventory names each failed definition and why it failed", () => {
  const inventory: PulseInventoryResponse = {
    definitions: [unavailable("d1", "Net Profit"), unavailable("d2", "Order Cost")],
    totalScanned: 2,
    truncated: false,
    failures: [
      { definitionId: "d1", stage: "list_metrics", diagnostic: { message: "GET /api/-/pulse/definitions/d1/metrics failed (429)", status: 429, kind: "http" } },
      { definitionId: "d2", stage: "list_metrics", diagnostic: { message: "GET /api/-/pulse/definitions/d2/metrics failed (429)", status: 429, kind: "http" } },
    ],
  };
  const markup = renderToStaticMarkup(<InventoryFailures inventory={inventory} />);
  assert.match(markup, /2 provider requests failed\./);
  assert.match(markup, /Listing metrics failed: Tableau is throttling requests \(HTTP 429\) \(2\)/);
  assert.match(markup, /Net Profit: GET \/api\/-\/pulse\/definitions\/d1\/metrics failed \(429\)/);
  assert.match(markup, /Order Cost: GET/);
});

test("complete inventory renders no failure banner", () => {
  const inventory: PulseInventoryResponse = { definitions: [], totalScanned: 0, truncated: false, failures: [] };
  assert.equal(renderToStaticMarkup(<InventoryFailures inventory={inventory} />), "");
});
