import assert from "node:assert/strict";
import test from "node:test";
import * as NodeModule from "node:module";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createAuthorController, useAuthor } from "./controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "../registry/controller";
import { useActivity } from "../activity/controller";
import { catalog, draft, session } from "../testing/fixtures";

// The shell's assets have no behavior in this offline component renderer.
const assets = NodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.endsWith(".png")) return { format: "module", source: 'export default "pulse-icon.png";', shortCircuit: true };
    const unrelatedWidgets: Record<string, string> = {
      "/components/LlmSettings.tsx": "LlmBadge",
      "/connections/Connect.tsx": "ConnectCard",
      "/author/DigestSettings.tsx": "DigestSettings",
      "/author/WorkingStateNotice.tsx": "WorkingStateNotice",
      "/components/ExistingMetrics.tsx": "ExistingMetrics",
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
  useRegistry.setState({ activateContext: async () => {} });
  useActivity.setState({ load: async () => {} });
  await act(async () => { renderer = create(<PulseApp />); });
  const mountedRenders = editorRenders;
  assert.ok(mountedRenders > 0, "the actual editor mounted and rendered its catalog");
  const measureTable = () => renderer!.root.findByProps({ "data-testid": "measure-list" });
  assert.ok(measureTable());

  for (const value of ["A", "A new", "A new request"]) {
    const composer = renderer!.root.findByProps({ "aria-label": "Message metric assistant" });
    act(() => composer.props.onChange({ target: { value } }));
    assert.equal(renderer!.root.findByProps({ "aria-label": "Message metric assistant" }).props.value, value);
    assert.equal(editorRenders, mountedRenders, "typing updates the real composer without rendering its sibling tables");
  }
  act(() => renderer!.update(<PulseApp />));
  assert.equal(editorRenders, mountedRenders, "an explicit parent render also skips the unchanged editor");

  act(() => {
    const current = useAuthor.getState().entries[record.id];
    useAuthor.setState({ entries: { [record.id]: { ...current, document: { ...current.document,
      metrics: { ...current.document.metrics, Sales: { ...current.document.metrics.Sales, name: "Net revenue" } } } } } });
  });
  assert.equal(editorRenders, mountedRenders + 1, "configuration changes still render the memoized editor through its subscription");
  assert.ok(measureTable().findByProps({ value: "Net revenue" }));
});
