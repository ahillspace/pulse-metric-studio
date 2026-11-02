import assert from "node:assert/strict";
import test from "node:test";
import React, { type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExistingMetrics } from "../components/ExistingMetrics";
import { useAuthor, type DraftEditor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "./controller";
import { registryApi, type RegistryApi } from "../api/registry";
import { unavailableFollowState } from "../follow-state";
import { deferred, draft, inventory, session } from "../testing/fixtures";

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
