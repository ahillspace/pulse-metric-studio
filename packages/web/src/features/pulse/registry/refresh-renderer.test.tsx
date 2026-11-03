import assert from "node:assert/strict";
import test from "node:test";
import React, { type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExistingMetrics } from "../components/ExistingMetrics";
import { createAuthorController, useAuthor, type DraftEditor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "./controller";
import { registryApi, type RegistryApi } from "../api/registry";
import { unavailableFollowState } from "../follow-state";
import { catalog, deferred, draft, inventory, session } from "../testing/fixtures";

function refreshButton(node: ReactNode): React.ButtonHTMLAttributes<HTMLButtonElement> | undefined {
  if (!React.isValidElement(node)) return;
  const props = node.props as React.ButtonHTMLAttributes<HTMLButtonElement>;
  if (node.type === "button" && props["aria-label"] === "Refresh metrics") return props;
  for (const child of React.Children.toArray(props.children)) {
    const found = refreshButton(child);
    if (found) return found;
  }
}

test("enabled Manager Refresh shows new metrics before old follower enrichment finishes", async (t) => {
  const originalAuthor = useAuthor.getState();
  const originalConnection = useConnection.getState();
  const originalRegistry = useRegistry.getState();
  t.after(() => {
    useAuthor.setState(originalAuthor, true);
    useConnection.setState(originalConnection, true);
    useRegistry.setState(originalRegistry, true);
  });
  t.mock.method(React, "useSyncExternalStore", <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot());
  const record = draft("manual-refresh");
  const entry: DraftEditor = {
    record, document: record.document, sequence: 0, savedSequence: 0,
    saveStatus: "saved", saveError: null, catalog: null,
    catalogLoading: false, catalogError: null, proposal: null,
    proposalSequence: 0, proposalBase: null, configurationEpoch: 0,
    proposalEpoch: 0, proposalNotice: null, proposalBusy: false,
    proposalMessage: "", proposalError: null, composer: "", preview: null,
    previewSequence: 0, previewBusy: false, publishBusy: false,
    publishError: null, publishCommandId: null, receipt: null,
  };
  useAuthor.setState({ activeId: record.id, entries: { [record.id]: entry } });
  useConnection.setState({ session });
  useRegistry.getState().setContext(record.context);
  const oldFollowers = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const enriching = deferred<void>();
  const followers = (metricId: string, count: number): Awaited<ReturnType<RegistryApi["followState"]>> => ({
    ...unavailableFollowState([metricId], "test"),
    selectedGroupId: null, groupContextUnavailable: false,
    groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {},
    followerCountsByMetricId: { [metricId]: count },
  });
  let reads = 0;
  t.mock.method(registryApi, "inventory", async () => inventory(++reads === 1 ? "old" : "new"));
  t.mock.method(registryApi, "followState", async (ids: string[]) => {
    if (ids.includes("old")) { enriching.resolve(); return oldFollowers.promise; }
    return followers("new", 7);
  });
  const renderManager = () => {
    let tree: ReactElement | undefined;
    function CaptureManager() { tree = ExistingMetrics({}); return tree; }
    const html = renderToStaticMarkup(<CaptureManager />);
    assert.ok(tree);
    return { html, button: refreshButton(tree) };
  };
  const initial = useRegistry.getState().ensureLoaded();
  await enriching.promise;
  try {
    assert.equal(useRegistry.getState().loading, false);
    assert.equal(useRegistry.getState().followLoading, true);
    const { button } = renderManager();
    assert.ok(button, "the real Manager exposes Refresh metrics");
    assert.equal(button.disabled, false, "Refresh is enabled while only follower data is pending");
    button.onClick!({} as React.MouseEvent<HTMLButtonElement>);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, "clicking the enabled button must request replacement inventory immediately");
    assert.equal(useRegistry.getState().inventory?.snapshotId, "snapshot-new");
    const refreshedHtml = renderManager().html;
    assert.match(refreshedHtml, /<button[^>]*>new<\/button>/);
    assert.doesNotMatch(refreshedHtml, /<button[^>]*>old<\/button>/);
    const replacement = structuredClone(useRegistry.getState().followState);
    oldFollowers.resolve(followers("old", 99));
    await initial;
    assert.deepEqual(useRegistry.getState().followState, replacement);
    assert.equal(useRegistry.getState().inventory?.snapshotId, "snapshot-new");
  } finally {
    oldFollowers.resolve(followers("old", 0));
    await initial;
  }
});

test("permission metadata refresh retains the mounted Manager preview scope", async (t) => {
  const originalAuthor = useAuthor.getState(); const originalConnection = useConnection.getState(); const originalRegistry = useRegistry.getState();
  const local = createAuthorController({ readDraft: async () => draft() } as any, async () => ({ catalog: catalog() }), () => session);
  await local.getState().openDraft("a");
  useAuthor.setState({ activeId: "a", entries: local.getState().entries });
  useConnection.setState({ session });
  useRegistry.setState({ inventory: inventory(), loading: false, busy: null });
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const originalDispatcher = dispatcher.current;
  t.after(() => { dispatcher.current = originalDispatcher; local.getState().dispose(); useAuthor.setState(originalAuthor, true); useConnection.setState(originalConnection, true); useRegistry.setState(originalRegistry, true); });
  const slots: any[] = []; let index = 0; let effects: (() => void)[] = [];
  const changed = (before: unknown[] | undefined, after: unknown[]) => !before || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]));
  const render = () => {
    index = 0; effects = [];
    dispatcher.current = {
      useState(initial: unknown) { const slot = index++; if (!(slot in slots)) slots[slot] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial }; return [slots[slot].value, (next: any) => { slots[slot].value = typeof next === "function" ? next(slots[slot].value) : next; }]; },
      useMemo(factory: () => unknown, deps: unknown[]) { const slot = index++; if (changed(slots[slot]?.deps, deps)) slots[slot] = { deps, value: factory() }; return slots[slot].value; },
      useEffect(effect: () => (() => void) | void, deps: unknown[]) { const slot = index++; if (changed(slots[slot]?.deps, deps)) effects.push(() => { slots[slot]?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; }); },
      useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) { return getSnapshot(); }, useCallback(callback: unknown) { return callback; }, useDebugValue() {},
    };
    try { ExistingMetrics({ visible: false }); } finally { dispatcher.current = originalDispatcher; }
    for (const effect of effects) effect();
  };
  render();
  const preview = slots.map(slot => slot?.value).find(value => typeof value === "function" && value.getState?.().setScope);
  assert.ok(preview);
  const scope = preview.getState().scope;
  assert.ok(scope);
  useConnection.setState({ session: { ...session, groupCreation: { state: "allowed", reasonCode: "verified", message: "Available" } } });
  render();
  assert.equal(preview.getState().scope, scope, "access metadata must not cancel an existing preview");
  useConnection.setState({ session: { ...session, sessionGeneration: 2 } });
  render();
  assert.notEqual(preview.getState().scope, scope, "a replacement authenticated owner still invalidates preview scope");
});
