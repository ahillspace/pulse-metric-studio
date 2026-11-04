import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { DimensionalFork } from "../components/DimensionalFork";
import { pulseDimensionalForkApi } from "../dimensional-fork-api";
import { session } from "../testing/fixtures";

test("timeframe-only filtering UI makes no reads until Add filters and reuses opaque context", async (t) => {
  const calls: string[] = [];
  t.mock.method(pulseDimensionalForkApi, "fields", async (ids: string[], context?: import("../dimensional-fork-api").DimensionContext) => {
    calls.push("fields"); assert.deepEqual(ids, ["metric"]); assert.equal(context?.snapshotId, "snapshot");
    assert.deepEqual(context?.owner, session);
    return { fields: [{ id: "region", name: "Region", label: "Region", dataType: "STRING", table: "Orders" }], sourceContextId: "opaque" };
  });
  t.mock.method(pulseDimensionalForkApi, "count", async (_ids: string[], _field: string, context?: import("../dimensional-fork-api").DimensionContext) => {
    calls.push("count"); assert.equal(context?.sourceContextId, "opaque"); return { count: 2 };
  });
  t.mock.method(pulseDimensionalForkApi, "values", async (_ids: string[], _field: string, _search: string, context?: import("../dimensional-fork-api").DimensionContext) => {
    calls.push("values"); assert.equal(context?.sourceContextId, "opaque"); return { values: [{ key: "east", label: "East", value: "East" }], truncated: false };
  });
  let sourceContext: string | undefined;
  let view!: ReturnType<typeof create>;
  await act(async () => { view = create(<DimensionalFork sources={[{ id: "metric", label: "Sales" }]} clauses={[]} context={{ snapshotId: "snapshot", owner: session }} onChange={() => {}} onEditingState={() => {}} onCompatibilityResolved={() => {}} onSourceContextResolved={id => { sourceContext = id; }} />); });
  t.after(() => act(() => view.unmount()));
  assert.deepEqual(calls, []);
  await act(async () => { view.root.findAll(node => node.type === "button" && node.children.includes("Add filters"))[0].props.onClick(); });
  assert.deepEqual(calls, ["fields"]); assert.equal(sourceContext, "opaque");
  await act(async () => { view.root.findByProps({ "aria-label": "Dimension field" }).props.onChange({ target: { value: "region" } }); });
  assert.deepEqual(calls, ["fields", "count", "values"]);
});
