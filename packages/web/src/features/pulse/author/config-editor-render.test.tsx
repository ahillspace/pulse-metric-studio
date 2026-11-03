import assert from "node:assert/strict";
import test from "node:test";
import * as NodeModule from "node:module";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createAuthorController, useAuthor } from "./controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "../registry/controller";
import { useActivity } from "../activity/controller";
import { pulseApi } from "../api/client";
import { catalog, draft, inventory, session } from "../testing/fixtures";

// The shell's assets have no behavior in this offline component renderer.
const assets = NodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.endsWith(".png")) return { format: "module", source: 'export default "pulse-icon.png";', shortCircuit: true };
    const unrelatedWidgets: Record<string, string> = {
      "/components/LlmSettings.tsx": "LlmBadge",
      "/connections/Connect.tsx": "ConnectCard",
      "/author/DigestSettings.tsx": "DigestSettings",
      "/activity/Activity.tsx": "Activity",
      "/components/DatasourcePicker.tsx": "DatasourcePicker",
      "/components/PublishSection.tsx": "PublishSection",
      "/shell/UpdateNotice.tsx": "UpdateNotice",
    };
    const widget = Object.entries(unrelatedWidgets).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (widget) return { format: "module", source: `export function ${widget}() { return null; }`, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { default: PulseApp } = await import("../PulseApp");
assets.deregister();

test("composer typing through the mounted shell does not rerender configuration tables", async (t) => {
  const originalAuthor = useAuthor.getState();
  const originalConnection = useConnection.getState();
  const originalRegistry = useRegistry.getState();
  const originalActivity = useActivity.getState();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let renderer: ReactTestRenderer | undefined;
  t.after(() => {
    act(() => renderer?.unmount());
    useAuthor.setState(originalAuthor, true);
    useConnection.setState(originalConnection, true);
    useRegistry.setState(originalRegistry, true);
    useActivity.setState(originalActivity, true);
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const browser = Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });

  const record = draft();
  const local = createAuthorController({ readDraft: async () => record } as any,
    async () => ({ catalog: catalog() }), () => session);
  t.after(() => local.getState().dispose());
  await local.getState().openDraft(record.id);
  const entry = local.getState().entries[record.id];
  let inventoryReads = 0;
  const existing = inventory();
  const definitions = existing.definitions;
  Object.defineProperty(existing, "definitions", { get() { inventoryReads++; return definitions; }, enumerable: true });
  let editorRenders = 0;
  const fields = { ...entry.catalog! };
  // ConfigEditor reads warnings on every render. Observe that read without replacing
  // the shell, editor, metric tables, memoization, or external-store hooks.
  Object.defineProperty(fields, "warnings", { get() { editorRenders++; return []; }, enumerable: true });
  // Keep external services inert while using the real shell, composer, configuration
  // editor, metric rows, React memoization, and store subscriptions.
  useAuthor.setState({ activeId: record.id, entries: { [record.id]: { ...entry, catalog: fields } },
    loadDrafts: async () => {}, refreshCatalog: async () => {} });
  useConnection.setState({ session, checked: true, init: async () => {} });
  useRegistry.setState({ context: record.context, owner: session, inventory: existing, loading: false,
    followLoading: false, followState: null, busy: null, activateContext: async () => {},
    ensureLoaded: async () => {}, ensureFollowState: async () => {} });
  useActivity.setState({ load: async () => {} });
  await act(async () => { renderer = create(<PulseApp />); });
  const mountedRenders = editorRenders;
  const mountedInventoryReads = inventoryReads;
  assert.ok(mountedRenders > 0, "the actual editor mounted and rendered its catalog");
  const measureTable = () => renderer!.root.findByProps({ "data-testid": "measure-list" });
  assert.ok(measureTable());

  for (const value of ["A", "A new", "A new request"]) {
    const composer = renderer!.root.findByProps({ "aria-label": "Message metric assistant" });
    act(() => composer.props.onChange({ target: { value } }));
    assert.equal(renderer!.root.findByProps({ "aria-label": "Message metric assistant" }).props.value, value);
    assert.equal(editorRenders, mountedRenders, "typing updates the real composer without rendering its sibling tables");
    assert.equal(inventoryReads, mountedInventoryReads, "typing does not reprocess retained inventory in the hidden Manager");
  }
  act(() => renderer!.update(<PulseApp />));
  assert.equal(editorRenders, mountedRenders, "an explicit parent render also skips the unchanged editor");
  assert.equal(inventoryReads, mountedInventoryReads, "an explicit parent render skips the unchanged Manager");

  act(() => {
    const current = useAuthor.getState().entries[record.id];
    useAuthor.setState({ entries: { [record.id]: { ...current, document: { ...current.document,
      metrics: { ...current.document.metrics, Sales: { ...current.document.metrics.Sales, name: "Net revenue" } } } } } });
  });
  assert.equal(editorRenders, mountedRenders + 1, "configuration changes still render the memoized editor through its subscription");
  assert.ok(measureTable().findByProps({ value: "Net revenue" }));

  act(() => renderer!.root.findByProps({ "aria-label": "Metric Manager" }).props.onClick());
  const definitionRows = () => renderer!.root.findAllByProps({ className: "def-head pulse-definition-head" });
  assert.equal(definitionRows().length, 1);
  const search = renderer!.root.findByProps({ placeholder: "Search definitions..." });
  act(() => search.props.onChange({ target: { value: "missing definition" } }));
  assert.equal(definitionRows().length, 0);
  act(() => search.props.onChange({ target: { value: "" } }));
  assert.equal(definitionRows().length, 1);
  act(() => renderer!.root.findByProps({ "aria-label": "Select displayed metrics in metric" }).props.onChange({ target: { checked: true } }));
  assert.equal(renderer!.root.findByProps({ "aria-label": "Select displayed metrics in metric" }).props.checked, true);
  act(() => renderer!.root.findByProps({ "aria-label": "Author" }).props.onClick());
  act(() => renderer!.root.findByProps({ "aria-label": "Message metric assistant" }).props.onChange({ target: { value: "Another request" } }));
  act(() => renderer!.root.findByProps({ "aria-label": "Metric Manager" }).props.onClick());
  assert.equal(renderer!.root.findByProps({ "aria-label": "Select displayed metrics in metric" }).props.checked, true,
    "visibility changes preserve Manager selection");
  const newer = inventory("new metric");
  act(() => useRegistry.setState({ inventory: newer }));
  assert.ok(renderer!.root.findAll((node) => node.type === "button" && node.children.includes("new metric")).length > 0,
    "new inventory still reaches the real visible Manager");
});

for (const area of ["Author", "Metric Manager"]) {
  test(`failed datasource and draft navigation stays visible in ${area} with a saved draft open`, async (t) => {
    const originalAuthor = useAuthor.getState(), originalConnection = useConnection.getState();
    const originalRegistry = useRegistry.getState(), originalActivity = useActivity.getState();
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    let renderer: ReactTestRenderer | undefined;
    t.after(() => {
      act(() => renderer?.unmount());
      useAuthor.setState(originalAuthor, true); useConnection.setState(originalConnection, true);
      useRegistry.setState(originalRegistry, true); useActivity.setState(originalActivity, true);
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    });
    const browser = Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
    const record = draft();
    const local = createAuthorController({ readDraft: async () => record } as any, async () => ({ catalog: catalog() }), () => session);
    t.after(() => local.getState().dispose());
    await local.getState().openDraft(record.id);
    useAuthor.setState({ activeId: record.id, entries: local.getState().entries, error: null,
      loadDrafts: async () => {}, refreshCatalog: async () => {} });
    useConnection.setState({ session, checked: true, init: async () => {} });
    useRegistry.setState({ activateContext: async () => {}, ensureLoaded: async () => {}, ensureFollowState: async () => {} });
    useActivity.setState({ load: async () => {} });
    t.mock.method(pulseApi, "createDraft", async () => { throw new Error("Cannot load selected datasource"); });
    t.mock.method(pulseApi, "readDraft", async () => { throw new Error("Cannot load selected draft"); });
    await act(async () => { renderer = create(<PulseApp />); });
    act(() => renderer!.root.findByProps({ "aria-label": area }).props.onClick());
    const visibleAlert = (message: string) => renderer!.root.findAll((node) => {
      if (node.props.role !== "alert" || !node.children.includes(message)) return false;
      for (let parent = node.parent; parent; parent = parent.parent) if (parent.props.hidden) return false;
      return true;
    });
    await act(async () => { await useAuthor.getState().selectDatasource({ luid: "b", name: "B", projectName: "" }); });
    assert.equal(useAuthor.getState().activeId, "a");
    assert.equal(useAuthor.getState().entries.a.saveStatus, "saved");
    assert.equal(visibleAlert("Cannot load selected datasource").length, 1);
    await act(async () => { await useAuthor.getState().openDraft("missing"); });
    assert.equal(visibleAlert("Cannot load selected draft").length, 1);
    assert.equal(useAuthor.getState().activeId, "a");
    const current = useAuthor.getState().entries.a;
    act(() => useAuthor.setState({ entries: { ...useAuthor.getState().entries,
      a: { ...current, saveStatus: "error", saveError: "Local storage unavailable" } } }));
    if (area === "Author") {
      assert.equal(visibleAlert("Cannot load selected draft").length, 1);
      assert.ok(renderer!.root.findByProps({ className: "pulse-metric-list", "data-testid": "measure-list" }));
      assert.ok(renderer!.root.findAll((node) => node.type === "button" && node.children.includes("Retry save")).length);
    }
    t.mock.method(pulseApi, "createDraft", async () => draft("b"));
    await act(async () => { await useAuthor.getState().selectDatasource({ luid: "b", name: "B", projectName: "" }); });
    assert.equal(useAuthor.getState().error, null);
    assert.equal(useAuthor.getState().activeId, "b");
    assert.equal(visibleAlert("Cannot load selected draft").length, 0);
  });
}
