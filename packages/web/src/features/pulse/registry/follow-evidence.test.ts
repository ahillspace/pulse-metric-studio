import assert from "node:assert/strict";
import test from "node:test";
import type { PulseFollowState } from "@pulse-metric-studio/shared";
import { createRegistryController } from "./controller";
import { registryApi, type RegistryApi } from "../api/registry";
import { deferred, draft, inventory, session } from "../testing/fixtures";
import { followStateLabel, selectFollowMetrics } from "../follow-state";

function state(ids: string[], detail: boolean, count = 5, followed = true): PulseFollowState {
  return {
    userFollowsByMetricId: detail ? Object.fromEntries(ids.map(id => [id, followed])) : {},
    groupFollowsByMetricId: detail ? Object.fromEntries(ids.map(id => [id, false])) : {},
    userFollowerIdsByMetricId: detail ? Object.fromEntries(ids.map(id => [id, followed ? [session.userId] : []])) : {},
    groupFollowerIdsByMetricId: detail ? Object.fromEntries(ids.map(id => [id, []])) : {},
    followerCountsByMetricId: Object.fromEntries(ids.map(id => [id, count])),
    availabilityByMetricId: Object.fromEntries(ids.map(id => [id, {
      status: detail ? "available" : "partial", relationshipStatus: detail ? "available" : "not_requested",
      followerIdsStatus: detail ? "available" : "not_requested", followerCountStatus: "available", diagnostics: [],
    }])), selectedGroupId: null, groupContextUnavailable: false, errors: [],
  };
}
function fixture(overrides: Partial<RegistryApi> = {}, metricIds = ["metric", "other"]) {
  let inventories = 0;
  const transport: RegistryApi = {
    inventory: async () => {
      const result = inventory("metric");
      result.snapshotId = `snapshot-${++inventories}`;
      result.definitions[0].metrics = metricIds.map(metricId => ({ ...result.definitions[0].metrics[0], metricId }));
      return result;
    },
    followState: async (ids, detail = true) => state(ids, detail),
    followTargets: async () => ({ targets: [], errors: [] }), followers: async () => ({ details: [] }),
    follow: async () => ({ results: [{ metricId: "metric", targetKind: "USER", targetId: session.userId, status: "followed", ok: true }] }),
    unfollow: async () => ({ results: [{ metricId: "metric", targetKind: "USER", targetId: session.userId, status: "unfollowed", ok: true }] }),
    fork: async () => ({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }),
    cancelJob: async () => { throw new Error("No batch is running."); }, ...overrides,
  };
  return createRegistryController(transport);
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function covered(ids: string[], completed: number): PulseFollowState {
  const result = state(ids, true);
  result.coverage = { status: completed === ids.length ? "available" : "partial", canLoadMore: completed < ids.length };
  ids.forEach((id, index) => {
    result.availabilityByMetricId[id] = {
      ...result.availabilityByMetricId[id]!,
      status: index < completed ? "available" : "partial",
      relationshipStatus: index < completed ? "available" : "unavailable",
      canLoadMore: index >= completed,
    };
  });
  return result;
}

test("205 demanded metrics retain the first batch's resumable coverage after the final five complete", async (t) => {
  const ids = Array.from({ length: 205 }, (_, index) => `m${index}`);
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { metricIds: batch, detail } = JSON.parse(init!.body as string);
    return Response.json(detail ? covered(batch, batch.length === 200 ? 19 : batch.length) : state(batch, false));
  });
  const store = fixture({ followState: registryApi.followState }, ids);
  await store.getState().activateContext(draft().context, "A", session);
  await store.getState().ensureFollowState(ids);
  assert.equal(store.getState().followState?.coverage?.canLoadMore, true);
  assert.equal(store.getState().followState?.coverage?.status, "partial");
  assert.equal(Object.values(store.getState().followState!.availabilityByMetricId!).filter(value => value.canLoadMore).length, 181);
  await store.getState().loadMoreFollowState(ids.slice(19, 200));
  assert.equal(store.getState().followState?.coverage?.canLoadMore, false, "completing the unresolved targets clears continuation");
});

test("sequential expansions preserve only current demand's continuation and terminal replacements clear it", async () => {
  let terminal = false;
  const store = fixture({ followState: async (ids, detail = true) => {
    if (!detail) return state(ids, false);
    const result = covered(ids, ids[0] === "other" ? ids.length : 0);
    if (terminal) {
      result.coverage = { status: "unavailable", canLoadMore: false };
      for (const availability of Object.values(result.availabilityByMetricId)) availability.canLoadMore = false;
    }
    return result;
  } });
  await store.getState().activateContext(draft().context, "A", session);
  await store.getState().ensureFollowState(["metric"]);
  await store.getState().ensureFollowState(["other"]);
  assert.equal(selectFollowMetrics(store.getState().followState!, ["metric", "other"]).coverage?.canLoadMore, true);
  assert.equal(selectFollowMetrics(store.getState().followState!, ["other"]).coverage?.canLoadMore, false, "collapsing the unresolved row removes active continuation");
  assert.equal(selectFollowMetrics(store.getState().followState!, []).coverage?.canLoadMore, false);
  terminal = true;
  await store.getState().loadMoreFollowState(["metric"]);
  assert.equal(store.getState().followState?.coverage?.canLoadMore, false);
});

test("a superseded resumable response cannot restore continuation after a completed replacement", async () => {
  const obsolete = deferred<PulseFollowState>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => !detail ? state(ids, false) : ++details === 1 ? obsolete.promise : covered(ids, ids.length) });
  await store.getState().activateContext(draft().context, "A", session);
  const old = store.getState().ensureFollowState(["metric"]);
  await store.getState().refreshFollowState(["metric"]);
  obsolete.resolve(covered(["metric"], 0)); await old;
  assert.equal(store.getState().followState?.coverage?.canLoadMore, false);
  assert.equal(store.getState().followState?.availabilityByMetricId?.metric.canLoadMore, false);
});

for (const replacement of ["completed", "terminal", "new-owner"] as const) {
  test(`a failed old continuation cannot restore retry after ${replacement} evidence`, async (t) => {
    const obsolete = deferred<Response>();
    let details = 0;
    t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { metricIds: ids, detail } = JSON.parse(init!.body as string);
      if (!detail) return Response.json(state(ids, false, 7));
      if (++details === 2) return obsolete.promise;
      const result = covered(ids, details === 1 || replacement === "terminal" ? 0 : ids.length);
      if (details > 1) for (const availability of Object.values(result.availabilityByMetricId)) availability.canLoadMore = false;
      result.followerCountsByMetricId = {};
      for (const availability of Object.values(result.availabilityByMetricId)) availability.followerCountStatus = "not_requested";
      return Response.json(result);
    });
    const store = fixture({ followState: registryApi.followState });
    await store.getState().activateContext(draft().context, "A", session);
    await store.getState().ensureFollowState(["metric"]);
    const continuation = store.getState().loadMoreFollowState(["metric"]);
    if (replacement === "new-owner") {
      await store.getState().activateContext(draft().context, "A", { ...session, sessionGeneration: 2 });
      await store.getState().ensureFollowState(["metric"]);
    } else await store.getState().refreshFollowState(["metric"]);
    obsolete.reject(new TypeError("Old IPC read failed")); await continuation;
    assert.equal(store.getState().followState?.availabilityByMetricId?.metric.canLoadMore, false);
    assert.equal(store.getState().followState?.coverage?.canLoadMore, false);
    assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 7);
  });
}

test("a failed continuation preserves retry only for metrics already known to be resumable", async (t) => {
  let details = 0;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { metricIds: ids, detail } = JSON.parse(init!.body as string);
    if (!detail) return Response.json(state(ids, false, 7));
    if (++details === 2) throw new TypeError("IPC read failed for the mixed selection");
    const result = covered(ids, 1);
    result.followerCountsByMetricId = {};
    for (const availability of Object.values(result.availabilityByMetricId)) availability.followerCountStatus = "not_requested";
    return Response.json(result);
  });
  const store = fixture({ followState: registryApi.followState }, ["complete", "resumable", "uninspected"]);
  await store.getState().activateContext(draft().context, "A", session);
  await store.getState().ensureFollowState(["complete", "resumable"]);
  await store.getState().loadMoreFollowState(["complete", "resumable", "uninspected"]);
  const result = store.getState().followState!;
  assert.equal(result.availabilityByMetricId?.resumable.canLoadMore, true);
  assert.notEqual(result.availabilityByMetricId?.complete.canLoadMore, true);
  assert.notEqual(result.availabilityByMetricId?.uninspected.canLoadMore, true);
  assert.equal(result.availabilityByMetricId?.resumable.relationshipStatus, "unavailable");
  assert.deepEqual(result.userFollowsByMetricId, {});
  assert.equal(result.followerCountsByMetricId.resumable, 7);
});

test("partial follow during pending inventory fences pre-write counts until a post-write count read", async (t) => {
  const oldCounts = deferred<PulseFollowState>();
  const countStarted = deferred<void>();
  let countReads = 0;
  let inventories = 0;
  const throttle = { retryAt: 36_000, serverTime: 0, reason: "throttle", sent: true };
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/api/tableau/throttle")) return Response.json({ throttled: false, retryAt: null, serverTime: 40_000, reason: null });
    if (String(url).includes("/api/pulse/follow-state")) {
      const { metricIds: ids, detail } = JSON.parse(init!.body as string);
      if (!detail) { countReads++; if (countReads === 1) { countStarted.resolve(); return Response.json(await oldCounts.promise); } return Response.json(state(ids, false, 1)); }
      const result = state(ids, true);
      result.followerCountsByMetricId = {};
      for (const availability of Object.values(result.availabilityByMetricId)) availability.followerCountStatus = "not_requested";
      return Response.json(result);
    }
    assert.ok(String(url).includes("/api/pulse/follow"));
    return Response.json({ stopped: true, throttle, results: [
      { metricId: "metric", targetKind: "USER", targetId: session.userId, status: "followed", ok: true, sent: true },
      { metricId: "other", targetKind: "USER", targetId: session.userId, status: "failed", ok: false, sent: true, throttle },
    ] }, { status: 207 });
  });
  const store = fixture({
    inventory: async () => { inventories++; const value = inventory(); value.definitions[0].metrics.push({ ...value.definitions[0].metrics[0], metricId: "other" }); return value; },
    followState: registryApi.followState, follow: registryApi.follow, throttle: registryApi.throttle,
  });
  const initial = store.getState().activateContext(draft().context, "A", session);
  await countStarted.promise;
  await store.getState().follow("follow", ["metric", "other"].map(metricId => ({ metricId, target: { kind: "USER", id: session.userId } })), [], []);
  oldCounts.resolve(state(["metric", "other"], false, 0)); await initial;
  assert.equal(store.getState().followState?.availabilityByMetricId?.metric.followerCountStatus, "not_requested");
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, undefined);
  await store.getState().pollCooldown();
  await store.getState().ensureFollowState(["metric"]);
  assert.equal(countReads, 2, "inspection requests a post-invalidation count without refreshing inventory");
  assert.equal(followStateLabel(store.getState().followState, "metric"), "You follow (1)");
  assert.equal(inventories, 1);
});

for (const kind of ["follow", "unfollow", "unknown"] as const) {
  test(`post-${kind} reconciliation cannot join pre-write metric evidence`, async () => {
    const old = deferred<PulseFollowState>();
    let details = 0;
    const followed = kind !== "unfollow";
    const store = fixture({
      followState: async (ids, detail = true) => !detail ? state(ids, false) : ++details === 1 ? old.promise : state(ids, true, 5, followed),
      ...(kind === "unknown" ? { follow: async () => ({ results: [{ metricId: "metric", targetKind: "USER" as const, targetId: session.userId, status: "unknown" as const, ok: false }], stopped: true }) } : {}),
    });
    await store.getState().activateContext(draft().context, "A", session);
    const before = store.getState().ensureFollowState(["metric"]);
    const mutation = store.getState().follow(kind === "unfollow" ? "unfollow" : "follow", [{ metricId: "metric", target: { kind: "USER", id: session.userId } }], [], []);
    try {
      await turn();
      assert.equal(details, 2, "submitted mutations require a newly dispatched inspection");
    } finally { old.resolve(state(["metric"], true, 0, !followed)); await Promise.all([before, mutation]); }
    assert.equal(store.getState().followState?.userFollowsByMetricId.metric, followed);
    assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
  });
}

test("old overlapping evidence preserves the unaffected metric but cannot overwrite reconciled metric", async () => {
  const old = deferred<PulseFollowState>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => !detail ? state(ids, false) : ++details === 1 ? old.promise : state(ids, true, 5, true) });
  await store.getState().activateContext(draft().context, "A", session);
  const before = store.getState().ensureFollowState(["metric", "other"]);
  await store.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: session.userId } }], [], []);
  old.resolve(state(["metric", "other"], true, 0, false));
  await before;
  assert.equal(store.getState().followState?.userFollowsByMetricId.metric, true);
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
  assert.equal(store.getState().followState?.userFollowsByMetricId.other, false);
});

test("ten overlapping expanded selections fetch ten IDs once with bounded concurrency", async () => {
  const held = deferred<void>();
  const requests: string[][] = [];
  let active = 0;
  let peak = 0;
  const ids = Array.from({ length: 10 }, (_, index) => `m${index}`);
  const store = fixture({ followState: async (batch, detail = true) => {
    if (!detail) return state(batch, false);
    requests.push(batch); peak = Math.max(peak, ++active);
    await held.promise; active--; return state(batch, true);
  } }, ids);
  await store.getState().activateContext(draft().context, "A", session);
  const expanding = ids.map((_, index) => store.getState().ensureFollowState(ids.slice(0, index + 1)));
  held.resolve(); await Promise.all(expanding);
  assert.equal(requests.flat().length, 10);
  assert.equal(new Set(requests.flat()).size, 10);
  assert.ok(peak <= 4, `expected four concurrent detail requests, got ${peak}`);
});

test("a current A caller consumes shared evidence after A-B-A navigation", async () => {
  const held = deferred<PulseFollowState>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => { if (!detail) return state(ids, false); details++; return held.promise; } });
  await store.getState().activateContext(draft("a").context, "A", session);
  const first = store.getState().ensureFollowState(["metric"]);
  await store.getState().activateContext(draft("b").context, "B", session);
  await store.getState().activateContext(draft("a").context, "A", session);
  const joined = store.getState().ensureFollowState(["metric"]);
  held.resolve(state(["metric"], true)); await Promise.all([first, joined]);
  assert.equal(details, 1);
  assert.equal(store.getState().followState?.userFollowsByMetricId.metric, true);
});

test("manual Refresh supersedes older pending detail without losing new inventory", async () => {
  const held = deferred<PulseFollowState>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => !detail ? state(ids, false, 9) : ++details === 1 ? held.promise : state(ids, true) });
  await store.getState().activateContext(draft().context, "A", session);
  const first = store.getState().ensureFollowState(["metric"]);
  await store.getState().invalidate();
  const replacement = store.getState().ensureFollowState(["metric"]);
  try { await turn(); assert.equal(details, 2); }
  finally { held.resolve(state(["metric"], true, 0, false)); await Promise.all([first, replacement]); }
  assert.equal(store.getState().inventory?.snapshotId, "snapshot-2");
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
});

test("detail evidence from a replaced authenticated owner never reaches the new owner's cache or display", async () => {
  const held = deferred<PulseFollowState>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => !detail ? state(ids, false) : ++details === 1 ? held.promise : state(ids, true) });
  await store.getState().activateContext(draft().context, "A", session);
  const old = store.getState().ensureFollowState(["metric"]);
  const replacement = { ...session, userId: "replacement", sessionGeneration: 2 };
  await store.getState().activateContext(draft().context, "A", replacement);
  await store.getState().ensureFollowState(["metric"]);
  held.resolve(state(["metric"], true, 0, false)); await old;
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
  store.getState().setContext(draft("other").context, "Other", replacement);
  store.getState().setContext(draft().context, "A", replacement);
  assert.equal(store.getState().followState?.userFollowsByMetricId.metric, true);
});

test("pending inventory overlays reject detail superseded by a later mutation", async () => {
  const counts = deferred<PulseFollowState>();
  const latest = deferred<PulseFollowState>();
  const started = deferred<void>();
  let details = 0;
  const store = fixture({ followState: async (ids, detail = true) => {
    if (!detail) { started.resolve(); return counts.promise; }
    return ++details === 1 ? state(ids, true, 0, false) : latest.promise;
  } });
  const initial = store.getState().activateContext(draft().context, "A", session);
  await started.promise;
  await store.getState().ensureFollowState(["metric"]);
  const mutation = store.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: session.userId } }], [], []);
  await turn();
  counts.resolve(state(["metric", "other"], false, 1)); await initial;
  assert.equal(store.getState().followState?.availabilityByMetricId?.metric.relationshipStatus, "not_requested");
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, undefined, "pre-write counts cannot return during post-write reconciliation");
  assert.equal(store.getState().followState?.followerCountsByMetricId.other, 1, "unaffected counts remain valid");
  latest.resolve(state(["metric"], true)); await mutation;
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
  assert.equal(store.getState().followState?.userFollowsByMetricId.metric, true);
});

for (const order of ["counts-first", "detail-first", "same-turn-counts-first", "same-turn-detail-first"] as const) {
  test(`inventory completion retains newest detail and settles loading: ${order}`, async () => {
    const counts = deferred<PulseFollowState>();
    const detail = deferred<PulseFollowState>();
    const countStarted = deferred<void>();
    let details = 0;
    const store = fixture({ followState: async (ids, requested = true) => {
      if (!requested) { countStarted.resolve(); return counts.promise; }
      return ++details === 1 ? detail.promise : state(ids, true);
    } });
    const loading = store.getState().activateContext(draft().context, "A", session);
    await countStarted.promise;
    const inspecting = store.getState().refreshFollowState(["metric"]);
    if (order === "counts-first") { counts.resolve(state(["metric", "other"], false, 1)); await turn(); detail.resolve(state(["metric"], true)); }
    else if (order === "detail-first") { detail.resolve(state(["metric"], true)); await turn(); counts.resolve(state(["metric", "other"], false, 1)); }
    else if (order === "same-turn-counts-first") { counts.resolve(state(["metric", "other"], false, 1)); detail.resolve(state(["metric"], true)); }
    else { detail.resolve(state(["metric"], true)); counts.resolve(state(["metric", "other"], false, 1)); }
    await Promise.all([loading, inspecting]);
    assert.equal(store.getState().loading, false);
    assert.equal(store.getState().followLoading, false);
    assert.equal(store.getState().followState?.userFollowsByMetricId.metric, true);
    assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 5);
    await store.getState().ensureFollowState(["other"]);
    assert.equal(details, 2, "another row can still request its missing relationship");
  });
}

test("only an explicit follower refresh asks the backend to reacquire retained coverage", async (t) => {
  const detailRequests: Array<{ metricIds: string[]; refresh?: boolean; continueCoverage?: boolean }> = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (body.detail) detailRequests.push({ metricIds: body.metricIds, refresh: body.refresh, continueCoverage: body.continueCoverage });
    return Response.json(state(body.metricIds, body.detail));
  });
  const store = fixture({ followState: registryApi.followState });
  await store.getState().activateContext(draft().context, "A", session);
  await store.getState().ensureFollowState(["metric"]);
  await store.getState().loadMoreFollowState(["metric"]);
  await store.getState().refreshFollowState(["metric"]);
  assert.deepEqual(detailRequests.map(request => [request.refresh, request.continueCoverage]), [[false, false], [false, true], [true, false]]);
});
