import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DimensionalFork } from "../components/DimensionalFork";
import { pulseDimensionalForkApi } from "../dimensional-fork-api";
import { ExistingMetrics } from "../components/ExistingMetrics";
import { createAuthorController, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "./controller";
import { pulseApi } from "../api/client";
import { decodeVariantResponse, registryApi, type RegistryApi } from "../api/registry";
import { unavailableFollowState } from "../follow-state";
import { MetricPreview } from "./MetricPreview";
import { catalog, deferred, draft, inventory, session } from "../testing/fixtures";

async function setup(t: import("node:test").TestContext, id = "a") {
  const globals = new Map(["document", "window", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
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
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return { mount: async (visible = false) => { await act(async () => { renderer = create(<ExistingMetrics visible={visible} />); }); return renderer!; } };
}

test("Manager shows continuation only while the unresolved metric is expanded", async (t) => {
  const fixture = await setup(t, "follow-demand");
  const followState = unavailableFollowState(["metric"], "Fixture page budget exhausted");
  followState.availabilityByMetricId!.metric.canLoadMore = true;
  followState.coverage = { status: "partial", canLoadMore: true };
  useRegistry.setState({ inventory: inventory(), followState, loading: false, followLoading: false });
  const renderer = await fixture.mount();
  const loadMore = () => renderer.root.findAll(node => node.type === "button" && node.children.includes("Load more follow details"));
  assert.equal(loadMore().length, 0);
  act(() => renderer.root.findAll(node => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick());
  assert.equal(loadMore().length, 1);
  act(() => renderer.root.findAll(node => node.type === "button" && node.children.includes("Collapse all"))[0].props.onClick());
  assert.equal(loadMore().length, 0);
});

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


test("mounted Manager preserves expansion and selection without demanding new relationships after a create patch", async (t) => {
  const fixture = await setup(t, "local-create-patch");
  const source = { ...inventory(), revision: 1, viewId: "create-view" };
  const calls: string[] = [];
  t.mock.method(registryApi, "inventory", async () => { calls.push("inventory"); return source; });
  t.mock.method(registryApi, "throttle", async () => ({ throttled: false, retryAt: null, serverTime: Date.now(), reason: null }));
  t.mock.method(registryApi, "followState", async (ids: string[], detail = true) => {
    calls.push(`${detail ? "details" : "counts"}:${ids.join(",")}`);
    return { ...unavailableFollowState(ids, "fixture"), selectedGroupId: null,
      followerCountsByMetricId: detail ? {} : { metric: 7 }, userFollowsByMetricId: detail ? { metric: true } : {},
      availabilityByMetricId: Object.fromEntries(ids.map(id => [id, { status: "available", relationshipStatus: detail ? "available" : "not_requested", followerIdsStatus: detail ? "available" : "not_requested", followerCountStatus: detail ? "not_requested" : "available", diagnostics: [] }])) };
  });
  t.mock.method(registryApi, "fork", async () => {
    calls.push("create");
    return { attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0,
      results: [{ sourceMetricId: "metric", metricId: "new", status: "created", creationStatus: "created", requestedSpecification: {} }],
      inventoryPatch: { version: 1, baseSnapshotId: source.snapshotId, snapshotId: "created", viewId: "create-view", revision: 2,
        upserts: [{ definitionId: "definition-metric", metric: { ...source.definitions[0].metrics[0], metricId: "new", name: "New variant", isDefault: null } }], removedMetricIds: [], removedDefinitionIds: [] } };
  });
  await useRegistry.getState().load();
  const renderer = await fixture.mount(true);
  await act(async () => { renderer.root.findAll(node => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick(); });
  act(() => renderer.root.findByProps({ "aria-label": "Select displayed metrics" }).props.onChange({ target: { checked: true } }));
  assert.deepEqual(calls, ["inventory", "counts:metric", "details:metric"]);
  await act(async () => { await useRegistry.getState().fork({ version: 1, sourceMetricIds: ["metric"], timeframe: { key: "MTD" }, clauses: [] }, new Map()); });
  assert.deepEqual(calls, ["inventory", "counts:metric", "details:metric", "create"]);
  assert.ok(renderer.root.findAll(node => node.type === "button" && node.props["aria-expanded"] === true).length);
  assert.ok(renderer.root.findAll(node => node.type === "span" && node.children.includes("1 selected")).length);
  assert.equal(useRegistry.getState().followState?.followerCountsByMetricId.new, undefined);
  assert.equal(useRegistry.getState().followState?.followerCountsByMetricId.metric, 7);
});

test("buffered pending deletion displays local cooldown inside its dialog and retains selection", async (t) => {
  const now = Date.now() + 2_000;
  t.mock.method(Date, "now", () => now);
  const fixture = await setup(t, "pending-cooldown");
  const source = inventory();
  useRegistry.setState({ inventory: source, followState: unavailableFollowState(["metric"], "fixture"), loading: false,
    deletePlan: { context: draft("pending-cooldown").context, snapshotId: source.snapshotId, metricIds: ["metric"], definitionIds: [], allowIncompleteInventory: false, previewFingerprint: "reviewed", warnings: [], targets: [] },
    busy: "delete", cooldown: null });
  let polls = 0;
  t.mock.method(registryApi, "throttle", async () => { polls++; return { throttled: true, retryAt: 36_000, serverTime: 0, reason: "throttle" }; });
  const renderer = await fixture.mount();
  assert.equal(polls, 1, "banner appearance does not immediately repoll the local endpoint");
  const dialogs = renderer.root.findAll(node => node.props.role === "dialog");
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].findAll(node => node.type === "p" && node.children.includes("Tableau is limiting requests. Waiting about 36 seconds.")).length);
  assert.equal(renderer.root.findByProps({ "aria-label": "Delete definition metric" }).props.disabled, true);
});


test("selecting ordinary variants for deletion never broadens to a definition or loads followers", async (t) => {
  const fixture = await setup(t, "variant-delete-selection");
  const source = inventory(); source.definitions[0].metrics[0].isDefault = false;
  useRegistry.setState({ inventory: source, followState: null, loading: false });
  let previews = 0;
  t.mock.method(registryApi, "followState", async () => { throw new Error("Selection and deletion review must not fetch relationships"); });
  t.mock.method(pulseApi, "previewDelete", async (input: Parameters<typeof pulseApi.previewDelete>[0]) => {
    previews++; assert.deepEqual(input.metricIds, ["metric"]); assert.deepEqual(input.definitionIds, []);
    return { ...input, previewFingerprint: "exact", warnings: [], targets: [] };
  });
  const renderer = await fixture.mount();
  act(() => renderer.root.findByProps({ "aria-label": "Select displayed metrics" }).props.onChange({ target: { checked: true } }));
  await act(async () => { renderer.root.findAll(node => node.type === "button" && node.children.includes("Delete selected"))[0].props.onClick(); });
  assert.equal(previews, 1);
  assert.equal(useRegistry.getState().followState, null);
});


test("deferred expansion cannot inspect a new row when pre-create counts finish later", async (t) => {
  const fixture = await setup(t, "deferred-expansion-create");
  const source = { ...inventory(), revision: 1, viewId: "pending-count-view" };
  const counts = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const detailIds: string[][] = [];
  t.mock.method(registryApi, "inventory", async () => source);
  t.mock.method(registryApi, "throttle", async () => ({ throttled: false, retryAt: null, serverTime: Date.now(), reason: null }));
  t.mock.method(registryApi, "followState", async (ids: string[], detail = true) => {
    if (!detail) return counts.promise;
    detailIds.push(ids);
    return { ...unavailableFollowState(ids, "fixture"), selectedGroupId: null };
  });
  t.mock.method(registryApi, "fork", async () => ({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0,
    results: [{ sourceMetricId: "metric", metricId: "new", status: "created", creationStatus: "created", requestedSpecification: {} }],
    inventoryPatch: { version: 1, baseSnapshotId: source.snapshotId, snapshotId: "new-snapshot", viewId: source.viewId, revision: 2,
      upserts: [{ definitionId: "definition-metric", metric: { ...source.definitions[0].metrics[0], metricId: "new" } }], removedMetricIds: [], removedDefinitionIds: [] } }));
  const loading = useRegistry.getState().load();
  await new Promise<void>(resolve => setImmediate(resolve));
  const renderer = await fixture.mount(true);
  act(() => renderer.root.findAll(node => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick());
  await act(async () => { await useRegistry.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map()); });
  assert.deepEqual(detailIds, []);
  const summary: Awaited<ReturnType<RegistryApi["followState"]>> = {
    userFollowsByMetricId: {}, groupFollowsByMetricId: {},
    userFollowerIdsByMetricId: {}, groupFollowerIdsByMetricId: {},
    selectedGroupId: null, groupContextUnavailable: false, errors: [],
    availabilityByMetricId: { metric: { status: "partial", relationshipStatus: "not_requested", followerIdsStatus: "not_requested", followerCountStatus: "available", diagnostics: [] } },
    followerCountsByMetricId: { metric: 7 },
  };
  await act(async () => { counts.resolve(summary); await loading; });
  assert.deepEqual(detailIds, [["metric"]]);
  assert.equal(useRegistry.getState().followState?.availabilityByMetricId?.new?.relationshipStatus, "not_requested");
});


test("a fast sent throttle failure keeps its banner in results and disables another create", async (t) => {
  const now = Date.now() + 6_000;
  t.mock.method(Date, "now", () => now);
  const fixture = await setup(t, "receipt-cooldown");
  useRegistry.setState({ inventory: inventory(), loading: false, followState: null });
  t.mock.method(registryApi, "throttle", async () => ({ throttled: false, retryAt: null, serverTime: now, reason: null }));
  t.mock.method(registryApi, "fork", async () => decodeVariantResponse({ ok: false, status: 502 }, {
    attempted: 1, created: 0, existing: 0, failed: 1, pendingVisibility: 0, sent: true,
    throttle: { retryAt: now + 40_000, serverTime: now, reason: "throttle", sent: true },
    results: [{ sourceMetricId: "metric", status: "failed", creationStatus: "failed", sent: true, requestedSpecification: {}, error: "HTTP 429" }],
  }));
  const renderer = await fixture.mount();
  act(() => renderer.root.findByProps({ "aria-label": "Select displayed metrics" }).props.onChange({ target: { checked: true } }));
  await act(async () => { await useRegistry.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map()); });
  const dialog = renderer.root.findAll(node => node.props.role === "dialog")[0];
  assert.ok(dialog.findAll(node => node.type === "p" && node.children.includes("Tableau is limiting requests. Waiting about 40 seconds.")).length);
  assert.ok(renderer.root.findAll(node => node.type === "button" && node.children.includes("Create variants"))[0].props.disabled);
  assert.ok(renderer.root.findAll(node => node.type === "span" && node.children.includes("1 selected")).length);
  assert.equal(useRegistry.getState().busy, null);
  assert.match(useRegistry.getState().results?.summary ?? "", /Tableau is limiting requests/);
});

for (const [index, kind] of ["inventory", "follow details", "follow targets", "followers"].entries()) test(`pending ${kind} acquires shared cooldown in the mounted Manager`, async (t) => {
  const now = Date.now() + 20_000 + index * 2_000;
  t.mock.method(Date, "now", () => now);
  const fixture = await setup(t, `read-cooldown-${index}`);
  useRegistry.setState({ inventory: inventory(), followState: null, busy: null, cooldown: null, loading: false });
  const held = deferred<any>();
  let polls = 0;
  t.mock.method(registryApi, "throttle", async () => { polls++; return { throttled: true, retryAt: now + 36_000, serverTime: now, reason: "throttle" }; });
  t.mock.method(registryApi, "followState", async () => ({ ...completeReadState(), selectedGroupId: null }));
  t.mock.method(registryApi, "inventory", async () => kind === "inventory" ? held.promise : inventory());
  t.mock.method(registryApi, "followTargets", async () => held.promise);
  t.mock.method(registryApi, "followers", async () => held.promise);
  if (kind === "follow details") t.mock.method(registryApi, "followState", async () => held.promise);
  const renderer = await fixture.mount();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = kind === "inventory" ? useRegistry.getState().refresh()
      : kind === "follow details" ? useRegistry.getState().ensureFollowState(["metric"])
      : kind === "follow targets" ? useRegistry.getState().loadTargets(true)
      : useRegistry.getState().loadFollowers(["metric"]);
  });
  assert.ok(useRegistry.getState().pendingProviderOperations > 0);
  assert.equal(polls, 1, "a pending read starts local status observation without a write");
  assert.equal(useRegistry.getState().cooldown?.remainingSeconds, 36);
  assert.equal(renderer.root.findAll(node => node.type === "button" && node.children.includes("Create variants"))[0].props.disabled, true);
  await act(async () => {
    held.resolve(kind === "inventory" ? inventory() : kind === "follow targets" ? { targets: [], errors: [] } : kind === "followers" ? { details: [] } : { ...completeReadState(), selectedGroupId: null });
    await pending;
  });
  assert.equal(useRegistry.getState().pendingProviderOperations, 0);
});

function completeReadState() {
  return { userFollowsByMetricId: {}, groupFollowsByMetricId: {}, followerCountsByMetricId: {}, availabilityByMetricId: {}, errors: [] };
}

test("a fast partial read after an unthrottled poll gets one trailing observation without idle polling", async (t) => {
  let now = Date.now() + 40_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await setup(t, "trailing-read-cooldown");
  useRegistry.setState({ inventory: inventory(), followState: null, busy: null, cooldown: null, loading: false });
  const held = deferred<Awaited<ReturnType<RegistryApi["followTargets"]>>>();
  let throttled = false;
  const polls: number[] = [];
  t.mock.method(registryApi, "throttle", async () => { polls.push(now); return { throttled, retryAt: throttled ? now + 30_000 : null, serverTime: now, reason: throttled ? "throttle" : null }; });
  t.mock.method(registryApi, "followTargets", async () => held.promise);
  const renderer = await fixture.mount();
  let pending!: Promise<unknown>;
  await act(async () => { pending = useRegistry.getState().loadTargets(true); });
  assert.equal(polls.length, 1);
  assert.equal(useRegistry.getState().cooldown, null);
  await act(async () => { throttled = true; held.resolve({ targets: [], errors: ["Provider read failed after the first status response"] }); await pending; });
  assert.equal(useRegistry.getState().pendingProviderOperations, 0);
  assert.equal(polls.length, 1, "completion must respect the status read frequency limit");
  await act(async () => { now += 999; t.mock.timers.tick(999); });
  assert.equal(polls.length, 1);
  await act(async () => { now += 1; t.mock.timers.tick(1); });
  assert.equal(polls.length, 2);
  assert.equal(useRegistry.getState().cooldown?.remainingSeconds, 30);
  assert.ok(renderer.root.findAll(node => node.type === "p" && node.children.includes("Tableau is limiting requests. Waiting about 30 seconds.")).length);
  await act(async () => { throttled = false; now += 1000; t.mock.timers.tick(1000); });
  assert.equal(useRegistry.getState().cooldown, null);
  const settled = polls.length;
  await act(async () => { now += 5000; t.mock.timers.tick(5000); });
  assert.equal(polls.length, settled, "idle Manager work must not keep polling local status");
});


for (const [index, stage] of ["fields", "count", "values"].entries()) test(`pending dimension ${stage} exposes the shared cooldown`, async (t) => {
  const now = Date.now() + 60_000 + index * 2_000;
  t.mock.method(Date, "now", () => now);
  const fixture = await setup(t, `dimension-read-${index}`);
  useRegistry.setState({ inventory: inventory(), followState: null, busy: null, cooldown: null, loading: false });
  const held = deferred<any>();
  const fields = { fields: [{ id: "region", name: "Region", label: "Region", dataType: "STRING", table: "Orders" }], sourceContextId: "opaque" };
  let polls = 0;
  t.mock.method(registryApi, "throttle", async () => { polls++; return { throttled: true, retryAt: now + 40_000, serverTime: now, reason: "throttle" }; });
  t.mock.method(pulseDimensionalForkApi, "fields", async () => stage === "fields" ? held.promise : fields);
  t.mock.method(pulseDimensionalForkApi, "count", async () => stage === "count" ? held.promise : { count: 2 });
  t.mock.method(pulseDimensionalForkApi, "values", async () => held.promise);
  const manager = await fixture.mount();
  let dimension!: ReactTestRenderer;
  await act(async () => { dimension = create(<DimensionalFork sources={[{ id: "metric", label: "Revenue" }]} clauses={[]} context={{ owner: session }} onChange={() => {}} onEditingState={() => {}} onCompatibilityResolved={() => {}} />); });
  t.after(() => act(() => dimension.unmount()));
  await act(async () => { dimension.root.findAll(node => node.type === "button" && node.children.includes("Add filters"))[0].props.onClick(); });
  if (stage !== "fields") await act(async () => { dimension.root.findByProps({ "aria-label": "Dimension field" }).props.onChange({ target: { value: "region" } }); });
  assert.ok(useRegistry.getState().pendingProviderOperations > 0);
  assert.equal(polls, 1, "sequential read stages share the same bounded status cadence");
  assert.ok(manager.root.findAll(node => node.type === "p" && node.children.includes("Tableau is limiting requests. Waiting about 40 seconds.")).length);
  assert.equal(manager.root.findAll(node => node.type === "button" && node.children.includes("Create variants"))[0].props.disabled, true);
  await act(async () => { held.resolve(stage === "fields" ? fields : stage === "count" ? { count: 2000 } : { values: [], truncated: false }); });
  assert.equal(useRegistry.getState().pendingProviderOperations, 0);
});

for (const [index, operation] of ["show", "refresh"].entries()) test(`card preview ${operation} acquires local cooldown while its provider request is pending`, async (t) => {
  let now = Date.now() + 100_000 + index * 2_000;
  t.mock.method(Date, "now", () => now);
  const fixture = await setup(t, `preview-cooldown-${index}`);
  useRegistry.setState({ inventory: inventory(), followState: null, busy: null, cooldown: null, loading: false });
  const held = deferred<Response>();
  let previews = 0, polls = 0;
  let limited = operation === "show";
  const image = { metricId: "metric", definitionId: "definition-metric", name: "Revenue", imageDataUrl: "data:image/png;base64,aW1hZ2U=", generatedAt: 1 };
  t.mock.method(globalThis, "fetch", async () => ++previews === 1 && operation === "refresh" ? Response.json(image) : held.promise);
  t.mock.method(registryApi, "throttle", async () => { polls++; return { throttled: limited, retryAt: limited ? now + 36_000 : null, serverTime: now, reason: limited ? "throttle" : null }; });
  const renderer = await fixture.mount();
  await act(async () => { renderer.root.findAll(node => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick(); });
  await act(async () => { renderer.root.findByProps({ title: "Preview metric" }).props.onClick(); });
  if (operation === "refresh") {
    assert.equal(useRegistry.getState().cooldown, null);
    await act(async () => { limited = true; now += 1000; void renderer.root.findByType(MetricPreview).props.state.refresh(); });
  }
  try {
    assert.equal(useRegistry.getState().pendingProviderOperations, 1);
    assert.ok(polls > 0, "preview work must acquire the shared local cooldown without a mutation");
    assert.equal(useRegistry.getState().cooldown?.remainingSeconds, 36);
    assert.ok(renderer.root.findAll(node => node.type === "p" && node.children.includes("Tableau is limiting requests. Waiting about 36 seconds.")).length);
    assert.equal(renderer.root.findAll(node => node.type === "button" && node.children.includes("Create variants"))[0].props.disabled, true);
  } finally {
    await act(async () => { held.resolve(Response.json(image)); await new Promise<void>(resolve => setImmediate(resolve)); });
  }
});

test("a fast terminal card preview after the first unthrottled status gets a trailing cooldown observation", async (t) => {
  let now = Date.now() + 110_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await setup(t, "fast-preview-cooldown");
  useRegistry.setState({ inventory: inventory(), followState: null, busy: null, cooldown: null, loading: false });
  const held = deferred<Response>();
  let limited = false;
  const polls: number[] = [];
  t.mock.method(globalThis, "fetch", async () => held.promise);
  t.mock.method(registryApi, "throttle", async () => { polls.push(now); return { throttled: limited, retryAt: limited ? now + 40_000 : null, serverTime: now, reason: limited ? "throttle" : null }; });
  const renderer = await fixture.mount();
  await act(async () => { renderer.root.findAll(node => node.type === "button" && node.children.includes("Expand all"))[0].props.onClick(); });
  await act(async () => { renderer.root.findByProps({ title: "Preview metric" }).props.onClick(); });
  assert.equal(polls.length, 1, "the preview must first observe an unthrottled provider status");
  assert.equal(useRegistry.getState().cooldown, null);
  await act(async () => { limited = true; held.resolve(Response.json({ error: "Provider limited preview" }, { status: 429 })); await new Promise<void>(resolve => setImmediate(resolve)); });
  assert.equal(renderer.root.findByType(MetricPreview).props.state.loading, false);
  await act(async () => { now += 1000; t.mock.timers.tick(1000); });
  assert.equal(useRegistry.getState().cooldown?.remainingSeconds, 40);
  assert.ok(polls.length >= 1);
  assert.ok(polls.slice(1).every((time, index) => time - polls[index] >= 1000));
});

for (const [index, kind] of ["fork", "delete", "follow", "unfollow"].entries()) test(`pending ${kind} in A keeps owner cooldown observation after navigating to warm B`, async (t) => {
  let now = Date.now() + 120_000 + index * 10_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = `mutation-owner-a-${index}`, b = `mutation-owner-b-${index}`;
  const fixture = await setup(t, a);
  const held = deferred<any>();
  let limited = false;
  const polls: number[] = [];
  t.mock.method(registryApi, "inventory", async () => inventory());
  t.mock.method(registryApi, "followState", async () => ({ ...completeReadState(), selectedGroupId: null }));
  t.mock.method(registryApi, "throttle", async () => { polls.push(now); return { throttled: limited, retryAt: limited ? now + 45_000 : null, serverTime: now, reason: limited ? "throttle" : null }; });
  t.mock.method(registryApi, "fork", async () => held.promise);
  t.mock.method(registryApi, "follow", async () => held.promise);
  t.mock.method(registryApi, "unfollow", async () => held.promise);
  t.mock.method(pulseApi, "delete", async () => held.promise);
  t.mock.method(pulseApi, "previewDelete", async (input: Parameters<typeof pulseApi.previewDelete>[0]) => ({ ...input, previewFingerprint: "reviewed", targets: [{ kind: "metric", id: "metric", name: "metric", definitionId: "definition-metric", inventoryComplete: true, affectedMetricIds: ["metric"] }], warnings: [] }));
  useRegistry.getState().setContext(draft(b).context, b, session);
  await useRegistry.getState().load();
  useRegistry.getState().setContext(draft(a).context, a, session);
  await useRegistry.getState().load();
  const renderer = await fixture.mount();
  await act(async () => { t.mock.timers.tick(0); });
  if (kind === "delete") await act(async () => { await useRegistry.getState().previewDelete(["metric"], []); });
  let mutation!: Promise<unknown>;
  await act(async () => {
    mutation = kind === "fork" ? useRegistry.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map())
      : kind === "delete" ? useRegistry.getState().executeDelete()
      : useRegistry.getState().follow(kind as "follow" | "unfollow", [{ metricId: "metric", target: { kind: "USER", id: "user" } }], [], []);
  });
  await act(async () => {
    const entry = useAuthor.getState().entries[a];
    useAuthor.setState({ activeId: b, entries: { ...useAuthor.getState().entries, [b]: { ...entry, record: draft(b) } } });
    useRegistry.getState().setContext(draft(b).context, b, session);
  });
  assert.equal(useRegistry.getState().busy, null, "presentation busy belongs to the visible datasource");
  try {
    const prior = polls.length;
    await act(async () => { limited = true; now += 1000; t.mock.timers.tick(1000); });
    assert.ok(polls.length > prior, "owner work must continue status observation after navigation clears presentation busy");
    assert.equal(useRegistry.getState().cooldown?.remainingSeconds, 45);
    assert.equal(renderer.root.findAll(node => node.type === "button" && node.children.includes("Create variants"))[0].props.disabled, true);
  } finally {
    await act(async () => {
      held.resolve(kind === "fork" ? { attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }
        : kind === "delete" ? { definitionsDeleted: 0, metricsDeleted: 0, failures: [], outcomes: [] } : { results: [] });
      await mutation;
    });
  }
  assert.equal(useRegistry.getState().busy, null);
  assert.ok(Object.keys(useRegistry.getState().outcomes).some(key => key.includes(a)), "the pending mutation receipt remains attached to its original datasource");
});
