import assert from "node:assert/strict";
import test from "node:test";
import type { PulseFollowState } from "@pulse-metric-studio/shared";
import { createRegistryController } from "./controller";
import type { RegistryApi } from "../api/registry";
import { deferred, draft, inventory, session } from "../testing/fixtures";

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
    fork: async () => ({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }), ...overrides,
  };
  return createRegistryController(transport);
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

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
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 1);
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
