import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ExistingMetrics } from "../components/ExistingMetrics";
import { createAuthorController, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "./controller";
import { registryApi, type RegistryApi } from "../api/registry";
import { unavailableFollowState } from "../follow-state";
import { MetricPreview } from "./MetricPreview";
import { catalog, deferred, draft, inventory, session } from "../testing/fixtures";

async function setup(t: import("node:test").TestContext, id = "a") {
  const originalAuthor = useAuthor.getState(), originalConnection = useConnection.getState(), originalRegistry = useRegistry.getState();
  const record = draft(id);
  const local = createAuthorController({ readDraft: async () => record } as any, async () => ({ catalog: catalog(id) }), () => session);
  await local.getState().openDraft(id);
  useAuthor.setState({ activeId: id, entries: local.getState().entries });
  useConnection.setState({ session });
  useRegistry.getState().setContext(record.context, id, session);
  let renderer: ReactTestRenderer | undefined;
  t.after(() => {
    act(() => renderer?.unmount()); local.getState().dispose();
    useAuthor.setState(originalAuthor, true); useConnection.setState(originalConnection, true); useRegistry.setState(originalRegistry, true);
  });
  return { mount: async () => { await act(async () => { renderer = create(<ExistingMetrics visible={false} />); }); return renderer!; } };
}

test("enabled Manager Refresh shows new metrics before old follower enrichment finishes", async (t) => {
  const fixture = await setup(t, "manual-refresh");
  const oldFollowers = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const enriching = deferred<void>();
  const followers = (metricId: string, count: number): Awaited<ReturnType<RegistryApi["followState"]>> => ({
    ...unavailableFollowState([metricId], "test"), selectedGroupId: null, groupContextUnavailable: false,
    groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {}, followerCountsByMetricId: { [metricId]: count },
  });
  let reads = 0;
  t.mock.method(registryApi, "inventory", async () => inventory(++reads === 1 ? "old" : "new"));
  t.mock.method(registryApi, "followState", async (ids: string[]) => {
    if (ids.includes("old")) { enriching.resolve(); return oldFollowers.promise; }
    return followers("new", 7);
  });
  const initial = useRegistry.getState().ensureLoaded();
  await enriching.promise;
  try {
    assert.equal(useRegistry.getState().loading, false);
    assert.equal(useRegistry.getState().followLoading, true);
    const renderer = await fixture.mount();
    const button = renderer.root.findByProps({ "aria-label": "Refresh metrics" });
    assert.equal(button.props.disabled, false, "Refresh is enabled while only follower data is pending");
    await act(async () => { button.props.onClick(); await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(reads, 2, "the enabled Refresh button requests replacement inventory immediately");
    assert.equal(useRegistry.getState().inventory?.snapshotId, "snapshot-new");
    assert.ok(renderer.root.findAll((node) => node.type === "button" && node.children.includes("new")).length);
    assert.equal(renderer.root.findAll((node) => node.type === "button" && node.children.includes("old")).length, 0);
    const replacement = structuredClone(useRegistry.getState().followState);
    await act(async () => { oldFollowers.resolve(followers("old", 99)); await initial; });
    assert.deepEqual(useRegistry.getState().followState, replacement);
    assert.equal(useRegistry.getState().inventory?.snapshotId, "snapshot-new");
  } finally { oldFollowers.resolve(followers("old", 0)); await initial; }
});

test("permission metadata refresh retains the mounted Manager preview scope", async (t) => {
  const fixture = await setup(t);
  const existing = inventory();
  existing.definitions[0].name = "Revenue";
  existing.definitions[0].metrics[0].name = "Monthly revenue";
  useRegistry.setState({ inventory: existing, loading: false, busy: null });
  const held = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => held.promise);
  const renderer = await fixture.mount();
  act(() => renderer.root.findAll((node) => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick());
  act(() => renderer.root.findByProps({ "aria-label": "Preview Monthly revenue" }).props.onClick());
  const scope = renderer.root.findByType(MetricPreview).props.state.scope;
  assert.ok(scope);
  act(() => useConnection.setState({ session: { ...session, groupCreation: { state: "allowed", reasonCode: "verified", message: "Available" } } }));
  assert.equal(renderer.root.findByType(MetricPreview).props.state.scope, scope, "access metadata does not cancel an existing preview");
  act(() => useConnection.setState({ session: { ...session, sessionGeneration: 2 } }));
  assert.equal(renderer.root.findAllByType(MetricPreview).length, 0, "a replacement owner invalidates the preview");
  await act(async () => { held.resolve(Response.json({ error: "Fixture preview completed after the owner changed." }, { status: 503 })); await new Promise<void>((resolve) => setImmediate(resolve)); });
});
