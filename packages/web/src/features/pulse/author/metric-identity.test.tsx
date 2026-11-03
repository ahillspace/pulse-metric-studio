import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { normalizeVdsToCatalog } from "@pulse-metric-studio/core";
import { emptyPulseDocument } from "@pulse-metric-studio/shared";
import { MetricTable } from "./MetricTable";
import { createAuthorController } from "./controller";
import { draft, session } from "../testing/fixtures";

test("raw field identities render before selection and survive selection, save, and reopen", async (t) => {
  const ids = ["Sales", "constructor", "toString", "__proto__"];
  const catalog = normalizeVdsToCatalog({ fieldGroups: [{ fields: ids.map((name) => ({
    name, caption: `Caption for ${name}`, role: "MEASURE", dataType: "REAL", defaultAggregation: "SUM",
  })) }] }, { luid: "a", name: "A" }, "vds");
  let saved = { ...draft(), document: emptyPulseDocument() };
  const transport = {
    readDraft: async () => structuredClone(saved),
    saveDraft: async (_id: string, input: { document: typeof saved.document; expectedRevision: number }) => {
      saved = { ...saved, revision: input.expectedRevision + 1, document: JSON.parse(JSON.stringify(input.document)) };
      return structuredClone(saved);
    },
  };
  const local = createAuthorController(transport as any, async () => ({ catalog }), () => session);
  t.after(() => local.getState().dispose());
  await local.getState().openDraft(saved.id);
  await local.getState().refreshCatalog();
  let renderer: ReactTestRenderer | undefined;
  t.after(() => act(() => renderer?.unmount()));
  const render = () => <MetricTable fields={catalog.measures.map((field) => ({
    id: field.id, label: field.label, dimension: false, field,
  }))} metrics={local.getState().entries.a.document.metrics} catalog={catalog}
    onToggle={local.getState().toggleMetric} onChange={local.getState().updateMetric} />;
  act(() => { renderer = create(render()); });
  for (const id of ids) {
    assert.equal(renderer!.root.findByProps({ "aria-label": `Use Caption for ${id}` }).props.checked, false);
    act(() => renderer!.root.findByProps({ "aria-label": `Use Caption for ${id}` }).props.onChange());
    local.getState().updateMetric(id, { name: `Metric ${id}` });
    act(() => renderer!.update(render()));
    assert.equal(renderer!.root.findByProps({ "aria-label": `Use Caption for ${id}` }).props.checked, true);
  }
  await local.getState().flush();
  const reopened = createAuthorController(transport as any, async () => ({ catalog }), () => session);
  t.after(() => reopened.getState().dispose());
  await reopened.getState().openDraft(saved.id);
  for (const id of ids) {
    assert.equal(Object.hasOwn(reopened.getState().entries.a.document.metrics, id), true);
    assert.equal(reopened.getState().entries.a.document.metrics[id].name, `Metric ${id}`);
  }
});
