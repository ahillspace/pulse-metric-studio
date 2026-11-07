import assert from "node:assert/strict";
import test from "node:test";
import type {
  PulseDeletePlan,
  PulseInventoryResponse,
  PulseMutationJobStatus,
  PulseVariantSummary,
} from "@pulse-metric-studio/shared";
import { createRegistryController } from "./controller";
import { applyInventoryPatch } from "./inventory-patch";
import { deferred, draft, inventory, session } from "../testing/fixtures";
import { unavailableFollowState } from "../follow-state";
import { decodeVariantResponse, registryApi, type RegistryApi } from "../api/registry";
import { pulseApi, PulseApiError, type PulseApi } from "../api/client";

function fixture(
  overrides: Partial<RegistryApi> = {},
  deletionOverrides: Partial<Pick<PulseApi, "previewDelete" | "delete">> = {},
) {
  const transport: RegistryApi = {
    inventory: async () => inventory(),
    followState: async (ids) => ({
      ...unavailableFollowState(ids, "unavailable"),
      selectedGroupId: null,
      groupContextUnavailable: false,
      groupFollowerIdsByMetricId: {},
      userFollowerIdsByMetricId: {},
      availabilityByMetricId: {},
    }),
    followTargets: async () => ({ targets: [], errors: [] }),
    followers: async () => ({ details: [] }),
    follow: async () => ({ results: [] }),
    unfollow: async () => ({ results: [] }),
    fork: async () => ({
      attempted: 0,
      created: 0,
      existing: 0,
      failed: 0,
      pendingVisibility: 0,
      results: [],
    }),
    cancelJob: async () => { throw new Error("No batch is running."); },
    ...overrides,
  };
  const deletion: Pick<PulseApi, "previewDelete" | "delete"> = {
    previewDelete: async (input) => ({
      ...input,
      previewFingerprint: "approved",
      warnings: [],
      targets: input.metricIds.map((id) => ({
        kind: "metric" as const,
        id,
        name: id,
        definitionId: "definition",
        inventoryComplete: true,
        affectedMetricIds: [id],
      })),
    }),
    delete: async (input) => ({
      definitionsDeleted: input.definitionIds.length,
      metricsDeleted: input.metricIds.length,
      failures: [],
      outcomes: [
        ...input.metricIds.map((metricId) => ({
          metricId,
          status: "deleted" as const,
        })),
        ...input.definitionIds.map((definitionId) => ({
          definitionId,
          status: "deleted" as const,
        })),
      ],
    }),
    ...deletionOverrides,
  };
  return createRegistryController(transport, deletion);
}

test("refresh retains known follows until replacement data arrives", async () => {
  const next = deferred<any>();
  let calls = 0;
  const known = unavailableFollowState(["metric"], "known");
  known.userFollowsByMetricId.metric = true;
  const store = fixture({
    followState: async () => (++calls === 1 ? known : next.promise),
  });
  store.getState().setContext(draft().context);
  await store.getState().load();
  const refresh = store.getState().load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    store.getState().followState?.userFollowsByMetricId.metric,
    true,
  );
  next.resolve(known);
  await refresh;
});

test("explicit refresh replaces inventory while earlier follower enrichment is pending", async () => {
  const oldFollowers = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const enriching = deferred<void>();
  let reads = 0;
  const freshFollowers: Awaited<ReturnType<RegistryApi["followState"]>> = {
    ...unavailableFollowState(["new"], "fresh"),
    selectedGroupId: null, groupContextUnavailable: false,
    groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {},
    followerCountsByMetricId: { new: 7 },
  };
  const store = fixture({
    inventory: async () => inventory(++reads === 1 ? "old" : "new"),
    followState: async (ids) => {
      if (ids.includes("old")) { enriching.resolve(); return oldFollowers.promise; }
      return freshFollowers;
    },
  });
  const context = draft().context;
  store.getState().setContext(context);
  const initial = store.getState().ensureLoaded();
  await enriching.promise;
  assert.equal(store.getState().loading, false);
  assert.equal(store.getState().followLoading, true);
  const navigationWhileEnriching = store.getState().ensureLoaded();
  assert.equal(store.getState().loading, false, "joining pending follow enrichment keeps manual Refresh available");
  try {
    const refreshing = store.getState().invalidate(context);
    const navigation = store.getState().ensureLoaded();
    assert.equal(reads, 2, "explicit refresh starts a new inventory read while navigation joins it");
    await Promise.all([refreshing, navigation]);
    assert.equal(store.getState().inventory?.snapshotId, "snapshot-new");
    assert.equal(store.getState().followState?.followerCountsByMetricId.new, 7);
    const replacement = structuredClone(store.getState().followState);
    oldFollowers.resolve({
      ...unavailableFollowState(["old"], "stale"),
      selectedGroupId: null, groupContextUnavailable: false,
      groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {},
      followerCountsByMetricId: { old: 99 },
    });
    await initial;
    assert.deepEqual(store.getState().followState, replacement, "late old followers cannot replace refreshed state");
    await store.getState().ensureLoaded();
    assert.equal(reads, 2, "the stale completion cannot displace the fresh inventory cache");
  } finally {
    oldFollowers.resolve(freshFollowers);
    await initial;
    await navigationWhileEnriching;
  }
});

test("deletion review requires displayed inventory without fetching a replacement", async () => {
  let reads = 0;
  let previews = 0;
  const store = fixture(
    { inventory: async () => { reads++; return inventory(); } },
    { previewDelete: async () => { previews++; throw new Error("Unexpected preview"); } },
  );
  store.getState().setContext(draft().context);
  await store.getState().previewDelete(["metric"], []);
  assert.equal(reads, 0);
  assert.equal(previews, 0);
  assert.equal(store.getState().deletePlan, null);
  assert.match(store.getState().deleteError ?? "", /Refresh metrics/);
});

test("deletion review freezes cached names and known follower counts without additional reads", async () => {
  const source = inventory();
  const sample = source.definitions[0].metrics[0];
  source.definitions[0].metrics = [
    { ...sample, name: "Loaded revenue" },
    { ...sample, metricId: "unknown", name: "Loaded margin" },
    { ...sample, metricId: "stale", name: "Loaded cost" },
  ];
  let reads = 0;
  let follows = 0;
  let details = 0;
  const reviewing = deferred<PulseDeletePlan>();
  const requests: unknown[] = [];
  const store = fixture({
    inventory: async () => { reads++; return source; },
    followState: async (ids) => {
      follows++;
      const unavailable = unavailableFollowState(ids, "Unavailable");
      const state: Awaited<ReturnType<RegistryApi["followState"]>> = {
        ...unavailable, selectedGroupId: null, groupContextUnavailable: false,
        groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {},
        availabilityByMetricId: unavailable.availabilityByMetricId ?? {},
      };
      state.followerCountsByMetricId = { metric: 7, stale: 3 };
      state.availabilityByMetricId.metric = { status: "available", relationshipStatus: "available", followerCountStatus: "available", diagnostics: [] };
      return state;
    },
    followers: async () => { details++; return { details: [] }; },
  }, {
    previewDelete: async (input) => { requests.push(input); return reviewing.promise; },
  });
  store.getState().setContext(draft().context);
  await store.getState().load();
  const preview = store.getState().previewDelete(["metric", "unknown", "stale"], []);
  store.getState().followState!.followerCountsByMetricId.metric = 99;
  reviewing.resolve({
    context: draft().context, snapshotId: source.snapshotId,
    metricIds: ["metric", "unknown", "stale"], definitionIds: [],
    allowIncompleteInventory: false, previewFingerprint: "reviewed", warnings: [],
    targets: ["metric", "unknown", "stale"].map((id) => ({
      kind: "metric", id, name: id, definitionId: "definition", inventoryComplete: true,
      affectedMetricIds: [id],
    })),
  });
  await preview;
  assert.deepEqual(requests, [{
    context: draft().context, snapshotId: source.snapshotId,
    metricIds: ["metric", "unknown", "stale"], definitionIds: [], allowIncompleteInventory: false,
  }]);
  assert.deepEqual(store.getState().deletePlan?.targets.flatMap((target) => target.affectedMetrics ?? []), [
    { id: "metric", name: "Loaded revenue", followerCount: 7 },
    { id: "unknown", name: "Loaded margin", followerCount: null },
    { id: "stale", name: "Loaded cost", followerCount: null },
  ]);
  assert.deepEqual({ reads, follows, details }, { reads: 1, follows: 1, details: 0 });
});

test("selection-scoped follower refresh batches exact IDs and preserves inventory state", async () => {
  const requests: string[][] = [];
  const store = fixture({ followState: async (ids, detail) => {
    if (detail) requests.push(ids);
    if (ids.includes("m200")) throw new Error("subscription read failed");
    return { ...unavailableFollowState(ids, "partial"), selectedGroupId: null,
      groupFollowerIdsByMetricId: {}, groupContextUnavailable: false, availabilityByMetricId: {},
      userFollowerIdsByMetricId: Object.fromEntries(ids.map(id => [id, ["subscriber"]])) };
  } });
  store.getState().setContext(draft().context);
  const before = store.getState().inventory;
  const ids = Array.from({length: 405}, (_, index) => `m${index}`);
  const result = await store.getState().refreshFollowState([...ids, "m0"]);
  assert.deepEqual(requests.flat(), ids);
  assert.deepEqual(requests.map(batch => batch.length), [100, 100, 100, 100, 5]);
  assert.deepEqual(result?.userFollowerIdsByMetricId?.m404, ["subscriber"]);
  assert.equal(result?.availabilityByMetricId?.m200.status, "unavailable");
  assert.equal(result?.userFollowerIdsByMetricId?.m200, undefined);
  assert.equal(store.getState().inventory, before);
  assert.deepEqual(store.getState().followState?.userFollowerIdsByMetricId?.m404, ["subscriber"]);
});

test("follower refresh discards identities after the datasource context changes", async () => {
  const response = deferred<any>();
  const store = fixture({ followState: () => response.promise });
  store.getState().setContext(draft("a").context);
  const refresh = store.getState().refreshFollowState(["metric"]);
  store.getState().setContext(draft("b").context);
  response.resolve({ ...unavailableFollowState(["metric"], "old"), selectedGroupId: null });
  assert.equal(await refresh, null);
  assert.equal(store.getState().followState, null);
});

test("dismissed results stay dismissed after switching context", async () => {
  const store = fixture();
  store.getState().setContext(draft("a").context);
  await store
    .getState()
    .fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  store.getState().dismissResults();
  store.getState().setContext(draft("b").context);
  store.getState().setContext(draft("a").context);
  assert.equal(store.getState().results, null);
});

test("reviewed deletion chunks all 1001 selected variants without omissions", async () => {
  const previews: number[] = [],
    deleted: string[] = [];
  let reads = 0;
  const store = fixture(
    { inventory: async () => { reads++; return inventory(); } },
    {
      previewDelete: async (input) => {
        previews.push(input.metricIds.length);
        assert.ok(input.metricIds.length <= 1000);
        assert.equal(input.snapshotId, "snapshot-metric");
        return {
          ...input,
          previewFingerprint: `review-${previews.length}`,
          warnings: [],
          targets: input.metricIds.map((id) => ({
            kind: "metric" as const,
            id,
            name: id,
            definitionId: "definition",
            inventoryComplete: true,
            affectedMetricIds: [id],
          })),
        };
      },
      delete: async (input) => {
        assert.equal(input.snapshotId, "snapshot-metric");
        deleted.push(...input.metricIds);
        return {
          definitionsDeleted: 0,
          metricsDeleted: input.metricIds.length,
          failures: [],
          outcomes: input.metricIds.map((metricId) => ({
            metricId,
            status: "deleted" as const,
          })),
        };
      },
    },
  );
  store.getState().setContext(draft().context);
  const ids = Array.from({ length: 1001 }, (_, index) => `variant-${index}`);
  await store.getState().load();
  await store.getState().previewDelete(ids, []);
  assert.equal(reads, 1, "review uses the displayed snapshot without reloading");
  assert.equal(store.getState().deletePlan?.targets.length, 1001);
  await store.getState().executeDelete();
  assert.deepEqual(previews, [1000, 1]);
  assert.deepEqual(deleted, ids);
  assert.equal(store.getState().results?.items.length, 1001);
  assert.equal(reads, 1, "deletion does not reload inventory or summary counts");
});

test("mixed bulk review removes covered children before splitting and retains earlier outcomes when a later plan changes", async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `variant-${index}`);
  let executions = 0;
  let reads = 0;
  const previews: Array<{ metricIds: string[]; definitionIds: string[] }> = [];
  const source = inventory();
  source.definitions[0].definitionId = "parent";
  source.definitions[0].metrics = [
    {
      ...source.definitions[0].metrics[0],
      metricId: "covered",
      isDefault: true,
    },
  ];
  const store = fixture(
    { inventory: async () => { reads++; return source; } },
    {
      previewDelete: async (input) => {
        previews.push(input);
        return {
          ...input,
          previewFingerprint: "reviewed",
          warnings: [],
          targets: [
            ...input.definitionIds.map((id) => ({
              kind: "definition" as const,
              id,
              name: id,
              definitionId: id,
              inventoryComplete: true,
              affectedMetricIds: ["covered"],
            })),
            ...input.metricIds.map((id) => ({
              kind: "metric" as const,
              id,
              name: id,
              definitionId: "other",
              inventoryComplete: true,
              affectedMetricIds: [id],
            })),
          ],
        };
      },
      delete: async (input) => {
        if (++executions === 2)
          throw new PulseApiError(
            "New variant appeared. Review again.",
            409,
            "delete_plan_changed",
          );
        return {
          definitionsDeleted: input.definitionIds.length,
          metricsDeleted: input.metricIds.length,
          failures: [],
          outcomes: [
            ...input.definitionIds.map((definitionId) => ({
              definitionId,
              status: "deleted" as const,
            })),
            ...input.metricIds.map((metricId) => ({
              metricId,
              status: "deleted" as const,
            })),
          ],
        };
      },
    },
  );
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete([...ids, "covered"], ["parent"]);
  assert.equal(
    previews.some((preview) => preview.metricIds.includes("covered")),
    false,
  );
  assert.equal(store.getState().deletePlan?.targets.length, 1002);
  await store.getState().executeDelete();
  const results = store.getState().results!.items;
  assert.equal(
    results.filter((item) => item.status === "removed").length,
    1001,
  );
  assert.equal(results.at(-1)?.status, "not_attempted");
  assert.match(results.at(-1)?.detail ?? "", /Review again/);
  assert.equal(reads, 1, "a rejected batch does not reload inventory");
});

test("uncertain bulk deletion stops unsent batches without reloading inventory", async () => {
  const ids = Array.from({ length: 2001 }, (_, index) => `variant-${index}`);
  let reads = 0;
  let executions = 0;
  const store = fixture({ inventory: async () => { reads++; return inventory(); } }, {
    delete: async (input) => {
      executions++;
      assert.equal(input.snapshotId, "snapshot-metric");
      if (executions === 1) return {
        definitionsDeleted: 0, metricsDeleted: input.metricIds.length, failures: [],
        outcomes: input.metricIds.map((metricId) => ({ metricId, status: "deleted" as const })),
      };
      return {
        definitionsDeleted: 0, metricsDeleted: 0, failures: ["Provider response lost"],
        outcomes: input.metricIds.map((metricId, index) => ({ metricId,
          status: index === 0 ? "unknown" as const : "not_attempted" as const,
        })),
      };
    },
  });
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete(ids, []);
  assert.equal(reads, 1);
  await store.getState().executeDelete();
  assert.equal(executions, 2);
  assert.equal(reads, 1);
  const items = store.getState().results!.items;
  assert.equal(items.filter((item) => item.status === "removed").length, 1000);
  assert.equal(items.filter((item) => item.status === "unknown").length, 1);
  assert.equal(items.filter((item) => item.status === "not_attempted").length, 1000);
  assert.equal(items.at(-1)?.metricId, "variant-2000");
});

test("navigation retains the owned inventory after deletion without a refresh", async () => {
  const refreshed = deferred<PulseInventoryResponse>();
  let reads = 0;
  const store = fixture({ inventory: async () => ++reads === 1 ? inventory() : refreshed.promise });
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete(["metric"], []);
  const deletion = store.getState().executeDelete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const navigation = store.getState().ensureLoaded();
  try {
    assert.equal(reads, 1, "deletion and navigation retain the owned inventory");
  } finally {
    refreshed.resolve(inventory("new"));
    await Promise.all([deletion, navigation]);
  }
});

test("unknown follow outcomes are excluded from automatic retry and later pairs remain not sent", async () => {
  const operations = Array.from({ length: 201 }, (_, index) => ({
    metricId: `metric-${index}`,
    target: { kind: "USER" as const, id: "user" },
  }));
  const store = fixture({
    follow: async (_context, batch) => ({
      stopped: true,
      results: batch.map((operation, index) => ({
        metricId: operation.metricId,
        targetId: "user",
        targetKind: "USER" as const,
        ok: index === 0,
        status:
          index === 0
            ? ("followed" as const)
            : index === 1
              ? ("unknown" as const)
              : ("not_attempted" as const),
      })),
    }),
  });
  store.getState().setContext(draft().context);
  const retry = await store.getState().follow("follow", operations, [], []);
  assert.equal(retry.length, 199);
  assert.equal(
    retry.some((operation) =>
      ["metric-0", "metric-1"].includes(operation.metricId),
    ),
    false,
  );
  assert.equal(store.getState().results!.items.at(-1)?.status, "not_attempted");
});

test("summary-only variant errors remain inspectable after inventory refresh", async () => {
  const store = fixture({
    fork: async () => ({
      attempted: 0,
      created: 0,
      existing: 0,
      failed: 0,
      pendingVisibility: 0,
      results: [],
      error: "Tableau stopped the operation before any source could be sent.",
    }),
  });
  store.getState().setContext(draft().context);
  await store
    .getState()
    .fork({ version: 1, sourceMetricIds: ["source"], clauses: [] }, new Map());
  assert.match(store.getState().results?.summary ?? "", /before any source/);
});

test("registry inventory and follower responses stay attached to their original context", async () => {
  const old = deferred<PulseInventoryResponse>();
  const store = fixture({
    inventory: (context) =>
      context.datasourceLuid === "a"
        ? old.promise
        : Promise.resolve(inventory("new")),
  });
  store.getState().setContext(draft("a").context);
  const loading = store.getState().load();
  store.getState().setContext(draft("b").context);
  await store.getState().load();
  old.resolve(inventory("old"));
  await loading;
  assert.equal(store.getState().inventory?.definitions[0].name, "new");
});

test("late fork outcomes remain accessible under their owner and never replace the current datasource", async () => {
  const response = deferred<PulseVariantSummary>();
  const store = fixture({ fork: () => response.promise });
  store.getState().setContext(draft("a").context);
  const running = store
    .getState()
    .fork(
      { version: 1, sourceMetricIds: ["source"], clauses: [] },
      new Map([["source", "Sales"]]),
    );
  store.getState().setContext(draft("b").context);
  response.resolve({
    attempted: 1,
    created: 0,
    existing: 0,
    failed: 1,
    pendingVisibility: 0,
    results: [
      {
        sourceMetricId: "source",
        status: "failed",
        creationStatus: "unknown",
        requestedSpecification: {},
        error: "Lost response",
      },
    ],
  });
  await running;
  assert.equal(store.getState().results, null);
  assert.equal(store.getState().busy, null);
  store.getState().setContext(draft("a").context);
  assert.equal(store.getState().results?.items[0].creationStatus, "unknown");
});

test("metric selection cannot imply definition deletion and execute uses exactly the reviewed fingerprint", async () => {
  const previews: unknown[] = [];
  const commands: unknown[] = [];
  const store = fixture(
    {},
    {
      previewDelete: async (input) => {
        previews.push(input);
        return {
          ...input,
          previewFingerprint: "exact",
          warnings: [],
          targets: input.metricIds.map((id) => ({
            kind: "metric",
            id,
            name: id,
            definitionId: "parent",
            inventoryComplete: true,
            affectedMetricIds: [id],
          })),
        };
      },
      delete: async (input) => {
        commands.push(input);
        return {
          definitionsDeleted: 0,
          metricsDeleted: 1,
          failures: [],
          outcomes: [{ metricId: "child", status: "deleted" }],
        };
      },
    },
  );
  const context = draft().context;
  store.getState().setContext(context);
  await store.getState().load();
  await store.getState().previewDelete(["child"], []);
  await store.getState().executeDelete();
  assert.deepEqual(previews, [
    {
      context,
      snapshotId: "snapshot-metric",
      metricIds: ["child"],
      definitionIds: [],
      allowIncompleteInventory: false,
    },
  ]);
  assert.deepEqual(commands, [
    {
      context,
      snapshotId: "snapshot-metric",
      metricIds: ["child"],
      definitionIds: [],
      previewFingerprint: "exact",
      allowIncompleteInventory: false,
    },
  ]);
  assert.equal(store.getState().results?.items[0].status, "removed");
});

test("explicit whole-definition previews retain the backend blast radius and partial outcomes", async () => {
  const store = fixture(
    {},
    {
      previewDelete: async (input) => ({
        ...input,
        previewFingerprint: "definition-plan",
        warnings: ["Subscriptions cascade"],
        targets: [
          {
            kind: "definition",
            id: "parent",
            name: "Sales",
            definitionId: "parent",
            inventoryComplete: true,
            affectedMetricIds: ["visible", "unlisted"],
          },
          {
            kind: "metric",
            id: "other",
            name: "Other",
            definitionId: "other-parent",
            inventoryComplete: true,
            affectedMetricIds: ["other"],
          },
        ],
      }),
      delete: async () => ({
        definitionsDeleted: 1,
        metricsDeleted: 0,
        failures: ["Forbidden"],
        outcomes: [
          { definitionId: "parent", status: "deleted" },
          { metricId: "other", status: "failed", error: "Forbidden" },
        ],
      }),
    },
  );
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete(["other"], ["parent"]);
  assert.deepEqual(store.getState().deletePlan?.targets[0].affectedMetricIds, [
    "visible",
    "unlisted",
  ]);
  await store.getState().executeDelete();
  assert.deepEqual(
    store.getState().results?.items.map((item) => item.status),
    ["removed", "failed"],
  );
});

test("denied cached deletion records errors only in results without refreshing", async () => {
  const calls: string[] = [];
  const store = fixture({
    inventory: async () => { calls.push("inventory"); return inventory(); },
    followState: async (ids) => { calls.push("counts"); return { ...unavailableFollowState(ids, "unavailable"),
      groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {}, selectedGroupId: null, groupContextUnavailable: false }; },
  }, {
    previewDelete: async (input) => {
      calls.push("cached-preview");
      return { ...input, previewFingerprint: "cached-reviewed", warnings: [], targets: input.metricIds.map(id => ({
        kind: "metric" as const, id, name: id, definitionId: "definition", inventoryComplete: true, affectedMetricIds: [id],
      })) };
    },
    delete: async (input) => {
      assert.deepEqual(input.metricIds, ["metric"]); assert.deepEqual(input.definitionIds, []);
      calls.push("DELETE metric");
      return { definitionsDeleted: 0, metricsDeleted: 0, failures: ["This account cannot delete the metric."],
        outcomes: [{ metricId: "metric", status: "failed", error: "This account cannot delete the metric." }] };
    },
  });
  store.getState().setContext(draft().context); await store.getState().load();
  await store.getState().previewDelete(["metric"], []);
  assert.deepEqual(calls, ["inventory", "counts", "cached-preview"], "review performs no new provider reads");
  await store.getState().executeDelete();
  assert.deepEqual(calls, ["inventory", "counts", "cached-preview", "DELETE metric"]);
  assert.equal(store.getState().deletePlan, null);
  assert.equal(store.getState().deleteError, null, "recorded execution errors must not reopen deletion review");
  assert.equal(store.getState().results?.items[0].status, "failed");
  assert.match(store.getState().results?.items[0].detail ?? "", /cannot delete/);
  assert.match(store.getState().results?.summary ?? "", /cannot delete/);
  store.getState().dismissResults();
  assert.equal(store.getState().results, null);
  assert.equal(store.getState().deleteError, null);
});

test("changed deletion plans clear approval without claiming success", async () => {
  const store = fixture(
    {},
    {
      delete: async () => {
        throw new PulseApiError(
          "The plan changed. Review it again.",
          409,
          "delete_plan_changed",
        );
      },
    },
  );
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete(["child"], []);
  await store.getState().executeDelete();
  assert.equal(store.getState().deletePlan, null);
  assert.equal(store.getState().results, null);
  assert.match(store.getState().deleteError ?? "", /plan changed/);
});

test("subscription retries contain only the exact unconfirmed pairs", async () => {
  const store = fixture({
    follow: async () => ({
      results: [
        {
          metricId: "m1",
          targetId: "u",
          targetKind: "USER",
          status: "followed",
          ok: true,
        },
        {
          metricId: "m2",
          targetId: "u",
          targetKind: "USER",
          status: "failed",
          ok: false,
          error: "Forbidden",
        },
      ],
    }),
  });
  store.getState().setContext(draft().context);
  const operations = ["m1", "m2"].map((metricId) => ({
    metricId,
    target: { id: "u", kind: "USER" as const },
  }));
  const retry = await store.getState().follow(
    "follow",
    operations,
    [
      { id: "m1", label: "One" },
      { id: "m2", label: "Two" },
    ],
    [{ id: "u", kind: "USER", label: "Person" }],
  );
  assert.deepEqual(retry, [operations[1]]);
  assert.equal(store.getState().results?.items.length, 2);
});

test("a stale follow-state response cannot replace a newly selected datasource", async () => {
  const old = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  let calls = 0;
  const store = fixture({
    inventory: async (context) => inventory(context.datasourceLuid),
    followState: async (ids) =>
      ++calls === 1
        ? old.promise
        : {
            userFollowsByMetricId: { b: true },
            groupFollowsByMetricId: {},
            groupFollowerIdsByMetricId: {},
            userFollowerIdsByMetricId: { b: ["u"] },
            followerCountsByMetricId: { b: 1 },
            availabilityByMetricId: {},
            groupContextUnavailable: false,
            selectedGroupId: null,
            errors: [],
          },
  });
  store.getState().setContext(draft("a").context);
  const loading = store.getState().load();
  await Promise.resolve();
  store.getState().setContext(draft("b").context);
  await store.getState().load();
  old.resolve({
    userFollowsByMetricId: { a: true },
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {},
    availabilityByMetricId: {},
    groupContextUnavailable: false,
    selectedGroupId: null,
    errors: [],
  });
  await loading;
  assert.deepEqual(store.getState().followState?.userFollowsByMetricId, {
    b: true,
  });
});

test("completed follower batches appear while a slower batch is still loading", async () => {
  const slow = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const unavailable = (ids: string[]) => ({
    ...unavailableFollowState(ids, "Provider unavailable"),
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    availabilityByMetricId: {},
    selectedGroupId: null,
    groupContextUnavailable: false,
  });
  const definitions = Array.from(
    { length: 201 },
    (_, index) => inventory(`m-${index}`).definitions[0],
  );
  const store = fixture({
    inventory: async () => ({
      snapshotId: "snapshot-many",
      definitions,
      totalScanned: 201,
      truncated: false,
      failures: [],
    }),
    followState: async (ids) =>
      ids.includes("m-200")
        ? slow.promise
        : {
            ...unavailable(ids),
            userFollowerIdsByMetricId: Object.fromEntries(
              ids.map((id) => [id, ["person"]]),
            ),
            errors: [],
          },
  });
  store.getState().setContext(draft().context);
  const loading = store.getState().load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    store.getState().followState?.userFollowerIdsByMetricId?.["m-0"],
    ["person"],
  );
  slow.resolve(unavailable(["m-200"]));
  await loading;
  assert.deepEqual(
    store.getState().followState?.userFollowerIdsByMetricId?.["m-0"],
    ["person"],
  );
});


test("author preload and manager navigation share one request and fresh snapshot", async () => {
  let calls = 0;
  const response = deferred<PulseInventoryResponse>();
  const store = fixture({ inventory: async () => { calls++; return response.promise; } });
  store.getState().setContext(draft().context);
  const author = store.getState().ensureLoaded();
  const manager = store.getState().ensureLoaded();
  assert.equal(calls, 1);
  response.resolve(inventory());
  await Promise.all([author, manager]);
  await store.getState().ensureLoaded();
  assert.equal(calls, 1);
  await store.getState().invalidate(draft().context);
  assert.equal(calls, 2);
});

test("follow and unfollow reconcile only their original affected metrics after navigation, including lost responses", async () => {
  for (const kind of ["follow", "unfollow"] as const) {
    for (const lost of [false, true]) {
      const response = deferred<Awaited<ReturnType<RegistryApi["follow"]>>>();
      const reads: string[] = [];
      const store = fixture({
        inventory: async (context) => { reads.push(context.datasourceLuid); return inventory(context.datasourceLuid); },
        [kind]: () => response.promise,
      });
      store.getState().setContext(draft("a").context);
      await store.getState().ensureLoaded();
      const changing = store.getState().follow(kind, [{ metricId: "a", target: { kind: "USER", id: "user" } }], [], []);
      store.getState().setContext(draft("b").context);
      await store.getState().ensureLoaded();
      if (lost) response.reject(new Error("Response lost"));
      else response.resolve({ results: [{ metricId: "a", targetKind: "USER", targetId: "user", ok: true, status: kind === "follow" ? "followed" : "unfollowed" }] });
      await changing;
      assert.equal(store.getState().inventory?.definitions[0].name, "b");
      assert.equal(store.getState().results, null);
      store.getState().setContext(draft("a").context);
      assert.equal(store.getState().inventory?.definitions[0].name, "a");
      assert.equal(store.getState().results?.kind, kind);
      await store.getState().ensureLoaded();
      assert.deepEqual(reads, ["a", "b"]);
    }
  }
});

test("inventory cache restores datasource snapshot and rejects late responses from other scope", async () => {
  const slow = deferred<PulseInventoryResponse>();
  const a = draft("a").context;
  const b = draft("b").context;
  let calls = 0;
  const store = fixture({ inventory: async (context) => { calls++; return context.datasourceLuid === a.datasourceLuid ? slow.promise : inventory("b"); } });
  store.getState().setContext(a);
  const first = store.getState().ensureLoaded();
  store.getState().setContext(b);
  await store.getState().ensureLoaded();
  slow.resolve(inventory("a"));
  await first;
  assert.equal(store.getState().inventory?.definitions[0].name, "b");
  store.getState().setContext(null);
  store.getState().setContext(b);
  await store.getState().ensureLoaded();
  assert.equal(calls, 2);
  assert.equal(store.getState().inventory?.definitions[0].name, "b");
});

test("incomplete inventory offers an explicit by-ID deletion review", async () => {
  const previews: boolean[] = [];
  const executed: boolean[] = [];
  const store = fixture(
    {},
    {
      previewDelete: async (input) => {
        previews.push(input.allowIncompleteInventory);
        if (!input.allowIncompleteInventory)
          throw new PulseApiError(
            "Tableau did not return the complete current inventory for this definition.",
            409,
            "delete_inventory_incomplete",
          );
        return {
          ...input,
          previewFingerprint: "by-id",
          warnings: [],
          targets: input.definitionIds.map((id) => ({
            kind: "definition" as const,
            id,
            name: id,
            definitionId: id,
            inventoryComplete: false,
            affectedMetricIds: [],
          })),
        };
      },
      delete: async (input) => {
        executed.push(input.allowIncompleteInventory);
        return {
          definitionsDeleted: 1,
          metricsDeleted: 0,
          failures: [],
          outcomes: [{ definitionId: "parent", status: "deleted" as const }],
        };
      },
    },
  );
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete([], ["parent"]);
  assert.equal(store.getState().deletePlan, null);
  assert.equal(store.getState().deleteOverridable, true);
  await store.getState().reviewDeleteAnyway();
  assert.equal(store.getState().deleteOverridable, false);
  assert.equal(store.getState().deleteError, null);
  assert.equal(store.getState().deletePlan?.allowIncompleteInventory, true);
  await store.getState().executeDelete();
  assert.deepEqual(previews, [false, true]);
  assert.deepEqual(executed, [true]);
  assert.equal(store.getState().results?.items[0].status, "removed");
});


test("unchanged autosave contexts never refresh inventory across TTL expiry", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let reads = 0;
  const store = fixture({ inventory: async () => { reads++; return inventory(); } });
  const context = draft().context;
  await store.getState().activateContext(context, "Source", session);
  for (let index = 0; index < 4; index++) {
    now += 90_000;
    await store.getState().activateContext(structuredClone(context), "Updated source", { ...session });
  }
  assert.equal(reads, 1);
  await store.getState().activateContext(draft("b").context, "B", session);
  assert.equal(reads, 2);
});

test("returning A-B-A shares the pending A operation and failures permit retry", async () => {
  const a = deferred<PulseInventoryResponse>();
  const reads: string[] = [];
  const store = fixture({ inventory: async (context) => {
    reads.push(context.datasourceLuid);
    return context.datasourceLuid === "a" ? a.promise : inventory("b");
  } });
  const first = store.getState().activateContext(draft("a").context, "A", session);
  await store.getState().activateContext(draft("b").context, "B", session);
  const returned = store.getState().activateContext(draft("a").context, "A", session);
  assert.deepEqual(reads, ["a", "b"]);
  a.resolve(inventory("a"));
  await Promise.all([first, returned]);
  assert.equal(store.getState().inventory?.snapshotId, "snapshot-a");
  let attempts = 0;
  const retry = fixture({ inventory: async () => { if (++attempts === 1) throw new Error("temporary"); return inventory(); } });
  retry.getState().setContext(draft().context, "A", session);
  await retry.getState().ensureLoaded();
  await retry.getState().ensureLoaded();
  assert.equal(attempts, 2);
  assert.equal(retry.getState().error, null);
});

test("a replacement principal or session cannot reuse inventory, reviews, or pending reads", async () => {
  let reads = 0;
  const store = fixture({ inventory: async () => { reads++; return inventory(); } });
  const context = draft().context;
  await store.getState().activateContext(context, "A", session);
  await store.getState().previewDelete(["metric"], []);
  assert.ok(store.getState().deletePlan);
  for (const owner of [{ ...session, sessionGeneration: 2 }, { ...session, sessionGeneration: 2, userId: "other" }]) {
    store.getState().setContext(context, "A", owner);
    assert.equal(store.getState().inventory, null);
    assert.equal(store.getState().deletePlan, null);
    await store.getState().ensureLoaded();
  }
  assert.equal(reads, 3);
});

test("close and unavailable admission blocks mutations and cancellation restores them", async () => {
  let forks = 0;
  let follows = 0;
  const store = fixture({
    fork: async () => { forks++; return { attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }; },
    follow: async () => { follows++; return { results: [] }; },
  });
  store.getState().setContext(draft().context, "A", session);
  store.getState().setMutationAvailable(false);
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], timeframe: { key: "mtd" } } as any, new Map());
  await store.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: "user" } }], [], []);
  assert.deepEqual({ forks, follows }, { forks: 0, follows: 0 });
  store.getState().setMutationAvailable(true);
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], timeframe: { key: "mtd" } } as any, new Map());
  assert.equal(forks, 1);
});

test("initial counts defer identities and following one of 405 metrics refreshes only it", async () => {
  let inventories = 0;
  const requests: Array<{ ids: string[]; detail: boolean }> = [];
  const source = inventory();
  const template = source.definitions[0].metrics[0];
  source.definitions[0].metrics = Array.from({ length: 405 }, (_, index) => ({ ...template, metricId: `m${index}` }));
  const store = fixture({
    inventory: async () => { inventories++; return source; },
    followState: async (ids, detail = true) => {
      requests.push({ ids, detail });
      return {
        ...unavailableFollowState(ids, "test"),
        selectedGroupId: null,
        groupContextUnavailable: false,
        groupFollowerIdsByMetricId: {},
        followerCountsByMetricId: Object.fromEntries(ids.map((id) => [id, detail ? 2 : 1])),
        userFollowerIdsByMetricId: detail ? Object.fromEntries(ids.map((id) => [id, ["person"]])) : {},
        availabilityByMetricId: Object.fromEntries(ids.map((id) => [id, { status: detail ? "available" : "partial", relationshipStatus: detail ? "available" : "not_requested", followerIdsStatus: detail ? "available" : "not_requested", followerCountStatus: "available", diagnostics: [] }])),
      };
    },
    follow: async () => ({ results: [{ metricId: "m200", targetKind: "USER", targetId: "person", status: "followed", ok: true }] }),
  });
  await store.getState().activateContext(draft().context, "A", session);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => !request.detail));
  requests.length = 0;
  await store.getState().follow("follow", [{ metricId: "m200", target: { kind: "USER", id: "person" } }], [], []);
  assert.equal(inventories, 1);
  assert.deepEqual(requests, [{ ids: ["m200"], detail: true }], "the detail response carries the post-write count");
  assert.equal(store.getState().followState?.followerCountsByMetricId.m199, 1);
  assert.equal(store.getState().followState?.followerCountsByMetricId.m200, 2);
  requests.length = 0;
  await store.getState().ensureFollowState(["m200", "m201"]);
  await store.getState().ensureFollowState(["m200", "m201"]);
  assert.deepEqual(requests, [{ ids: ["m201"], detail: true }]);
});

test("follow directory shares mounts but explicit refresh and new session reload", async () => {
  let reads = 0;
  const store = fixture({ followTargets: async () => { reads++; return { targets: [], errors: [] }; } });
  store.getState().setContext(draft().context, "A", session);
  await Promise.all([store.getState().loadTargets(), store.getState().loadTargets()]);
  await store.getState().loadTargets();
  assert.equal(reads, 1);
  await store.getState().loadTargets(true);
  assert.equal(reads, 2);
  store.getState().setContext(draft().context, "A", { ...session, sessionGeneration: 2 });
  await store.getState().loadTargets();
  assert.equal(reads, 3);
});

test("a slow initial count response cannot erase newer targeted mutation reconciliation", async () => {
  const oldCounts = deferred<Awaited<ReturnType<RegistryApi["followState"]>>>();
  const countStarted = deferred<void>();
  let countReads = 0;
  const fresh = { ...unavailableFollowState(["metric"], "fresh"), selectedGroupId: null, groupContextUnavailable: false,
    userFollowerIdsByMetricId: { metric: ["person"] }, groupFollowerIdsByMetricId: {},
    followerCountsByMetricId: { metric: 2 }, availabilityByMetricId: { metric: { status: "available" as const, relationshipStatus: "available" as const, followerCountStatus: "available" as const, diagnostics: [] } } };
  const store = fixture({
    followState: async (_ids, detail) => { if (!detail && ++countReads === 1) { countStarted.resolve(); return oldCounts.promise; } return fresh; },
    follow: async () => ({ results: [{ metricId: "metric", targetKind: "USER", targetId: "person", status: "followed", ok: true }] }),
  });
  const initial = store.getState().activateContext(draft().context, "A", session);
  await countStarted.promise;
  await store.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: "person" } }], [], []);
  oldCounts.resolve({ ...fresh, followerCountsByMetricId: { metric: 1 }, userFollowerIdsByMetricId: {}, availabilityByMetricId: { metric: { status: "partial", relationshipStatus: "not_requested", followerCountStatus: "available", diagnostics: [] } } });
  await initial;
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 2);
  assert.deepEqual(store.getState().followState?.userFollowerIdsByMetricId?.metric, ["person"]);
});

test("unavailable initial counts do not prevent an explicit row identity read", async () => {
  const details: string[][] = [];
  const store = fixture({ followState: async (ids, detail) => {
    if (!detail) throw new Error("count service unavailable");
    details.push(ids);
    return { ...unavailableFollowState(ids, "counts unavailable"), selectedGroupId: null, groupContextUnavailable: false,
      userFollowerIdsByMetricId: { metric: ["person"] }, groupFollowerIdsByMetricId: {}, availabilityByMetricId: {} };
  } });
  await store.getState().activateContext(draft().context, "A", session);
  assert.equal(store.getState().followState?.availabilityByMetricId?.metric.relationshipStatus, "not_requested");
  await store.getState().ensureFollowState(["metric"]);
  assert.deepEqual(details, [["metric"]]);
  assert.deepEqual(store.getState().followState?.userFollowerIdsByMetricId?.metric, ["person"]);
});


test("manual refresh passes explicit freshness without changing navigation requests", async () => {
  const options: unknown[] = [];
  const store = fixture({ inventory: async (_context, _owner, request) => { options.push(request); return inventory(); } });
  store.getState().setContext(draft().context);
  await store.getState().ensureLoaded();
  await store.getState().refresh();
  assert.deepEqual(options, [undefined, { refresh: true }]);
});

function inventoryPatch(revision: number, upserts: import("@pulse-metric-studio/shared").PulseInventoryPatch["upserts"] = [], removedMetricIds: string[] = []): import("@pulse-metric-studio/shared").PulseInventoryPatch {
  return { version: 1, baseSnapshotId: "snapshot-metric", snapshotId: `patched-${revision}`, viewId: "owned-view", revision, upserts, removedMetricIds, removedDefinitionIds: [] };
}

function completeCounts(ids: string[], detail: boolean): Awaited<ReturnType<RegistryApi["followState"]>> {
  return { userFollowsByMetricId: detail ? Object.fromEntries(ids.map(id => [id, true])) : {}, groupFollowsByMetricId: {},
    userFollowerIdsByMetricId: {}, groupFollowerIdsByMetricId: {}, followerCountsByMetricId: detail ? {} : Object.fromEntries(ids.map(id => [id, 7])),
    availabilityByMetricId: Object.fromEntries(ids.map(id => [id, { status: "available", relationshipStatus: detail ? "available" : "not_requested", followerIdsStatus: detail ? "available" : "not_requested", followerCountStatus: detail ? "not_requested" : "available", diagnostics: [] }])),
    errors: [], selectedGroupId: null, groupContextUnavailable: false };
}

test("confirmed and duplicate variants patch once by ID with no inventory or follower reload", async () => {
  let reads = 0, writes = 0;
  const followReads: Array<{ ids: string[]; detail: boolean }> = [];
  const row = { ...inventory().definitions[0].metrics[0], metricId: "new", isDefault: null };
  const store = fixture({
    inventory: async () => { reads++; return { ...inventory(), viewId: "owned-view", revision: 1 }; },
    followState: async (ids, detail = true) => { followReads.push({ ids, detail }); return completeCounts(ids, detail); },
    fork: async (_context, _request, _owner, options) => {
      assert.equal(options?.snapshotId, writes ? "patched-2" : "snapshot-metric");
      writes++;
      return { attempted: 1, created: writes === 1 ? 1 : 0, existing: writes === 1 ? 0 : 1, failed: 0, pendingVisibility: 0,
        results: [{ sourceMetricId: "metric", metricId: "new", status: writes === 1 ? "created" : "existing", creationStatus: writes === 1 ? "created" : "existing", requestedSpecification: {} }],
        inventoryPatch: inventoryPatch(writes + 1, [{ definitionId: "definition-metric", metric: row }]) };
    },
  });
  store.getState().setContext(draft().context, "A", session);
  await store.getState().load();
  await store.getState().ensureFollowState(["metric"]);
  const evidence = structuredClone(store.getState().followState);
  const command = { version: 1 as const, sourceMetricIds: ["metric"], clauses: [] };
  await store.getState().fork(command, new Map());
  assert.equal(store.getState().results?.items[0].status, "created");
  await store.getState().fork(command, new Map());
  assert.equal(store.getState().results?.items[0].status, "existing");
  assert.equal(reads, 1);
  assert.deepEqual(followReads, [{ ids: ["metric"], detail: false }, { ids: ["metric"], detail: true }]);
  assert.equal(store.getState().inventory?.definitions[0].metrics.filter(metric => metric.metricId === "new").length, 1);
  assert.equal(store.getState().inventory?.definitions[0].metrics.find(metric => metric.metricId === "new")?.isDefault, null);
  assert.equal(store.getState().followState?.followerCountsByMetricId.metric, 7);
  assert.equal(store.getState().followState?.userFollowsByMetricId.metric, evidence?.userFollowsByMetricId.metric);
  assert.equal(store.getState().followState?.availabilityByMetricId?.new?.relationshipStatus, "not_requested");
  assert.equal(store.getState().followState?.followerCountsByMetricId.new, undefined);
  await store.getState().ensureFollowState(["metric"]);
  assert.equal(followReads.length, 2, "existing relationship evidence survives both patches");
  await store.getState().ensureFollowState(["new"]);
  assert.deepEqual(followReads.slice(2), [{ ids: ["new"], detail: true }]);
});

test("a pending older refresh cannot lose a confirmed create or replace its snapshot", async () => {
  const refresh = deferred<PulseInventoryResponse>();
  let reads = 0;
  const row = { ...inventory().definitions[0].metrics[0], metricId: "new" };
  const store = fixture({
    inventory: async () => ++reads === 1 ? { ...inventory(), revision: 1, viewId: "initial" } : refresh.promise,
    fork: async () => ({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0,
      results: [{ sourceMetricId: "metric", metricId: "new", status: "created", creationStatus: "created", requestedSpecification: {} }],
      inventoryPatch: inventoryPatch(3, [{ definitionId: "definition-metric", metric: row }]) }),
  });
  store.getState().setContext(draft().context);
  await store.getState().load();
  const refreshing = store.getState().refresh();
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  refresh.resolve({ ...inventory(), revision: 2, viewId: "refresh" });
  await refreshing;
  assert.equal(reads, 2, "only the explicit refresh reads inventory");
  assert.equal(store.getState().inventory?.snapshotId, "patched-3");
  assert.ok(store.getState().inventory?.definitions[0].metrics.some(metric => metric.metricId === "new"));
});

test("partial deletion patches only confirmed removals and an older refresh cannot resurrect them", async () => {
  const refresh = deferred<PulseInventoryResponse>();
  let reads = 0;
  const source = inventory();
  source.definitions[0].metrics.push({ ...source.definitions[0].metrics[0], metricId: "unknown" });
  const store = fixture({ inventory: async () => ++reads === 1 ? { ...source, revision: 1 } : refresh.promise }, {
    delete: async () => ({ definitionsDeleted: 0, metricsDeleted: 1, failures: ["Lost second response"],
      outcomes: [{ metricId: "metric", status: "deleted" }, { metricId: "unknown", status: "unknown" }], inventoryPatch: inventoryPatch(3, [], ["metric"]) }),
  });
  store.getState().setContext(draft().context);
  await store.getState().load();
  await store.getState().previewDelete(["metric", "unknown"], []);
  const refreshing = store.getState().refresh();
  await store.getState().executeDelete();
  assert.deepEqual(store.getState().results?.items.map(item => item.status), ["removed", "unknown"]);
  refresh.resolve({ ...source, revision: 2 }); await refreshing;
  assert.deepEqual(store.getState().inventory?.definitions[0].metrics.map(metric => metric.metricId), ["unknown"]);
  assert.equal(reads, 2);
});

test("local throttle refusals remain unsent without inventory refresh and cooldown status is owner fenced", async () => {
  let reads = 0, statusReads = 0;
  const status = deferred<Awaited<ReturnType<NonNullable<RegistryApi["throttle"]>>>>();
  const store = fixture({
    inventory: async () => { reads++; return inventory(); },
    fork: async () => { throw new PulseApiError("Wait for Tableau cooldown", 429, undefined, undefined, { retryAt: 36_000, serverTime: 0, reason: "throttle", sent: false }); },
    throttle: async () => { statusReads++; return status.promise; },
  });
  store.getState().setContext(draft().context, "A", session); await store.getState().load();
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  assert.equal(store.getState().results?.items[0].status, "not_attempted");
  assert.equal(reads, 1);
  assert.equal(store.getState().cooldown?.remainingSeconds, 36);
  store.getState().setContext(draft("b").context, "B", session);
  assert.equal(store.getState().cooldown?.remainingSeconds, 36, "same-owner datasource changes retain the identity-wide wait");
  const polling = store.getState().pollCooldown();
  store.getState().setContext(draft().context, "A", { ...session, sessionGeneration: 2 });
  status.resolve({ throttled: true, retryAt: 36_000, serverTime: 0, reason: "throttle" }); await polling;
  assert.equal(statusReads, 1); assert.equal(store.getState().cooldown, null);
});


test("sent throttle receipts show cooldown after fast failure and reject older unthrottled polls", async () => {
  const initialStatus = deferred<Awaited<ReturnType<NonNullable<RegistryApi["throttle"]>>>>();
  const now = Date.now();
  const throttle = { retryAt: now + 40_000, serverTime: now, reason: "throttle" as const, sent: true };
  const summary = decodeVariantResponse({ ok: false, status: 502 }, {
    attempted: 1, created: 0, existing: 0, failed: 1, pendingVisibility: 0, throttle, sent: true,
    results: [{ sourceMetricId: "metric", status: "failed", creationStatus: "failed", sent: true, requestedSpecification: {}, error: "HTTP 429" }],
  });
  const store = fixture({ fork: async () => summary, throttle: async () => initialStatus.promise });
  store.getState().setContext(draft().context, "A", session);
  const poll = store.getState().pollCooldown();
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  assert.equal(store.getState().busy, null);
  assert.equal(store.getState().cooldown?.remainingSeconds, 40, "A valid failed receipt must seed the banner after a fast terminal response.");
  assert.match(store.getState().results?.summary ?? "", /Tableau is limiting requests/);
  initialStatus.resolve({ throttled: false, retryAt: null, serverTime: now, reason: null }); await poll;
  assert.equal(store.getState().cooldown?.retryAt, throttle.retryAt, "A status read started before the receipt cannot erase its newer throttle.");
  let overlappingWrites = 0;
  const blocked = fixture({ fork: async () => { overlappingWrites++; return summary; } });
  blocked.getState().setContext(draft().context, "A", session);
  blocked.setState({ cooldown: store.getState().cooldown });
  await blocked.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  assert.equal(overlappingWrites, 0);
});


for (const kind of ["follow", "unfollow"] as const) for (const sent of [true, false]) test(`real ${kind} ${sent ? "sent partial" : "unsent admission"} receipt retains its throttle`, async (t) => {
  const throttle = { retryAt: 36_000, serverTime: 0, reason: "throttle" as const, sent };
  let providerFollowReads = 0, writes = 0;
  t.mock.method(globalThis, "fetch", async () => {
    writes++;
    return Response.json({ stopped: true, sent, throttle, results: [
      { metricId: "metric", targetId: "user", targetKind: "USER", status: sent ? "failed" : "not_attempted", ok: false, sent, throttle },
    ] }, { status: sent ? 207 : 429 });
  });
  const store = fixture({ [kind]: registryApi[kind], followState: async () => { providerFollowReads++; return completeCounts(["metric"], true); } });
  store.getState().setContext(draft().context, "A", session);
  const operations = Array.from({ length: 201 }, (_, index) => ({ metricId: index ? `other-${index}` : "metric", target: { kind: "USER" as const, id: "user" } }));
  await store.getState().follow(kind, operations, [], []);
  assert.equal(store.getState().cooldown?.remainingSeconds, 36);
  assert.equal(store.getState().busy, null);
  assert.equal(store.getState().results?.items[0].status, sent ? "failed" : "not_attempted");
  assert.equal(store.getState().results?.items.at(-1)?.status, "not_attempted");
  assert.equal(writes, 1, "known throttle prevents dispatching a second batch");
  assert.equal(providerFollowReads, 0, "known cooldown prevents automatic relationship reads");
});


test("a new backend owner lifetime replaces retired local receipts without journal replay", async () => {
  const base = { ...inventory(), lifetimeId: "retired", revision: 1 };
  const created = { ...structuredClone(base), snapshotId: "patched-2", viewId: "owned-view", revision: 2 };
  created.definitions[0].metrics.push({ ...created.definitions[0].metrics[0], metricId: "retired-local" });
  let reads = 0;
  const store = fixture({
    inventory: async () => ++reads === 1 ? base : { ...inventory(), lifetimeId: "replacement", revision: 1 },
    fork: async () => ({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0, results: [],
      inventoryPatch: { ...inventoryPatch(2, [{ definitionId: "definition-metric", metric: created.definitions[0].metrics[1] }]), lifetimeId: "retired", inventory: created } }),
  });
  store.getState().setContext(draft().context, "A", session);
  await store.getState().load();
  await store.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  await store.getState().refresh();
  assert.deepEqual(store.getState().inventory?.definitions[0].metrics.map(row => row.metricId), ["metric"]);
  assert.equal((store.getState().inventory as any)?.lifetimeId, "replacement");
  assert.equal(store.getState().inventory?.revision, 1);
});

test("reverse mutation receipts retain every confirmed create after A B A navigation", async () => {
  const first = deferred<PulseVariantSummary>();
  const second = deferred<PulseVariantSummary>();
  const base = { ...inventory(), lifetimeId: "owner-lifetime", revision: 1 };
  const snapshot = (revision: number, ids: string[]) => ({ ...structuredClone(base), snapshotId: `patched-${revision}`, viewId: "owned-view", revision,
    definitions: base.definitions.map(definition => ({ ...definition, metrics: [...definition.metrics, ...ids.map(metricId => ({ ...definition.metrics[0], metricId }))] })) });
  const receipt = (revision: number, ids: string[]): PulseVariantSummary => ({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0, results: [],
    inventoryPatch: { ...inventoryPatch(revision, [{ definitionId: "definition-metric", metric: { ...base.definitions[0].metrics[0], metricId: ids.at(-1)! } }]), lifetimeId: base.lifetimeId, inventory: snapshot(revision, ids) } as any });
  let writes = 0;
  const store = fixture({ inventory: async () => base, fork: async () => ++writes === 1 ? first.promise : second.promise });
  store.getState().setContext(draft().context, "A", session);
  await store.getState().load();
  const command = { version: 1 as const, sourceMetricIds: ["metric"], clauses: [] };
  const one = store.getState().fork(command, new Map());
  store.getState().setContext(draft("b").context, "B", session);
  store.getState().setContext(draft().context, "A", session);
  const two = store.getState().fork(command, new Map());
  second.resolve(receipt(3, ["one", "two"])); await two;
  first.resolve(receipt(2, ["one"])); await one;
  assert.deepEqual(store.getState().inventory?.definitions[0].metrics.map(row => row.metricId), ["metric", "one", "two"]);
  assert.equal(store.getState().inventory?.revision, 3);
});

test("provider read errors retain structured cooldown and fence pending work by owner", async () => {
  const held = deferred<never>();
  const store = fixture();
  store.getState().setContext(draft().context, "A", session);
  const read = store.getState().trackProviderOperation(() => held.promise).catch(() => undefined);
  assert.equal(store.getState().pendingProviderOperations, 1);
  store.getState().setContext(draft("b").context, "B", session);
  assert.equal(store.getState().pendingProviderOperations, 1, "same-owner work remains visible across datasources");
  held.reject(new PulseApiError("Wait", 429, undefined, undefined, { retryAt: 50_000, serverTime: 0, reason: "throttle", sent: true }));
  await read;
  assert.equal(store.getState().cooldown?.remainingSeconds, 50);
  assert.equal(store.getState().pendingProviderOperations, 0);
  const stale = deferred<never>();
  const old = store.getState().trackProviderOperation(() => stale.promise).catch(() => undefined);
  store.getState().setContext(draft().context, "New owner", { ...session, sessionGeneration: 2 });
  assert.equal(store.getState().pendingProviderOperations, 0);
  stale.reject(new PulseApiError("Old wait", 429, undefined, undefined, { retryAt: 90_000, serverTime: 0, reason: "throttle", sent: true }));
  await old;
  assert.equal(store.getState().cooldown, null);
});

test("late mutation from a retired backend lifetime cannot replace a new authoritative read", async () => {
  const held = deferred<PulseVariantSummary>();
  const base = { ...inventory(), lifetimeId: "retired", revision: 1 };
  const replacement = { ...inventory("replacement"), lifetimeId: "new", revision: 1 };
  let reads = 0;
  const store = fixture({ inventory: async () => ++reads === 1 ? base : replacement, fork: async () => held.promise });
  store.getState().setContext(draft().context, "A", session);
  await store.getState().load();
  const mutation = store.getState().fork({ version: 1, sourceMetricIds: ["metric"], clauses: [] }, new Map());
  await store.getState().refresh();
  held.resolve({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0, results: [{ sourceMetricId: "metric", metricId: "retired-local", status: "created", creationStatus: "created", requestedSpecification: {} }],
    inventoryPatch: { ...inventoryPatch(2), lifetimeId: "retired", inventory: { ...base, revision: 2 } } });
  await mutation;
  assert.deepEqual(store.getState().inventory, replacement);
  assert.equal(store.getState().results?.items[0].status, "created", "the confirmed receipt remains inspectable even though its retired snapshot is rejected");
});

test("real deletion partial receipt retains its sent throttle after completion", async (t) => {
  const throttle = { retryAt: 36_000, serverTime: 0, reason: "throttle", sent: true };
  t.mock.method(globalThis, "fetch", async () => Response.json({ throttle, sent: true,
    definitionsDeleted: 0, metricsDeleted: 0, failures: ["HTTP 429"], outcomes: [{ metricId: "metric", status: "failed", sent: true, throttle }],
  }, { status: 207 }));
  const store = fixture({}, { delete: pulseApi.delete });
  store.getState().setContext(draft().context, "A", session);
  await store.getState().load();
  await store.getState().previewDelete(["metric"], []);
  await store.getState().executeDelete();
  assert.equal(store.getState().cooldown?.remainingSeconds, 36);
  assert.equal(store.getState().busy, null);
  assert.equal(store.getState().results?.items[0].status, "failed");
});

test("complete receipt coordinates must match the normalized snapshot envelope", () => {
  const base = { ...inventory(), lifetimeId: "owner", revision: 1, viewId: "owned-view" };
  const patch = { ...inventoryPatch(2), lifetimeId: "owner", inventory: { ...base, snapshotId: "patched-2", revision: 2 } };
  for (const conflict of [{ snapshotId: "wrong" }, { viewId: "wrong" }, { lifetimeId: "wrong" }, { revision: 3 }]) {
    assert.equal(applyInventoryPatch(base, { ...patch, inventory: { ...patch.inventory, ...conflict } }), base);
  }
  assert.equal(applyInventoryPatch(base, patch), patch.inventory);
});

for (const replacementOwner of [false, true]) test(`owner activity permits healthy overlap and fences old completions (${replacementOwner ? "replacement owner" : "same owner"})`, async () => {
  const first = deferred<PulseVariantSummary>(), second = deferred<PulseVariantSummary>();
  let writes = 0;
  const store = fixture({ fork: async () => ++writes === 1 ? first.promise : second.promise });
  store.getState().setContext(draft().context, "A", session);
  const command = { version: 1 as const, sourceMetricIds: ["metric"], clauses: [] };
  const a = store.getState().fork(command, new Map());
  assert.equal(store.getState().pendingProviderOperations, 1);
  store.getState().setContext(draft("b").context, "B", replacementOwner ? { ...session, sessionGeneration: 2 } : session);
  assert.equal(store.getState().busy, null);
  const b = store.getState().fork(command, new Map());
  assert.equal(writes, 2, "owner activity observes healthy work without adding mutation serialization");
  assert.equal(store.getState().pendingProviderOperations, replacementOwner ? 1 : 2);
  first.resolve({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] });
  await a;
  assert.equal(store.getState().pendingProviderOperations, 1, "old completion cannot decrement another pending owner's work");
  assert.equal(store.getState().busy, "fork", "old completion cannot clear a newer visible mutation's busy state");
  second.resolve({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] });
  await b;
  assert.equal(store.getState().pendingProviderOperations, 0);
  assert.equal(store.getState().busy, null);
  assert.equal(Object.keys(store.getState().outcomes).length, 2);
});

function jobStatus(id: string, overrides: Partial<PulseMutationJobStatus> = {}): PulseMutationJobStatus {
  return { id, kind: "follow", state: "running", total: 1, completed: 0, throttled: true, retryAt: 60_000, serverTime: 0, stopReason: null, ...overrides };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("a cancel the server does not confirm is reported and can be pressed again", async () => {
  const response = deferred<Awaited<ReturnType<RegistryApi["follow"]>>>();
  const cancels: string[] = [];
  let reject = true;
  const store = fixture({
    follow: async (_context, _batch, _owner, observe) => { observe?.(jobStatus("job-1")); return response.promise; },
    cancelJob: async (id) => {
      cancels.push(id);
      if (reject) throw new Error("The desktop service is unavailable.");
      return jobStatus(id, { state: "stopping", stopReason: "cancelled" });
    },
  });
  store.getState().setContext(draft().context, "A", session);
  const running = store.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: "user" } }], [], []);
  await settle();
  await store.getState().cancelJob();
  let job = store.getState().job!;
  assert.equal(job.stopping, false, "an unconfirmed cancel does not claim the batch is stopping");
  assert.equal(job.cancelling, false, "Cancel is available again");
  assert.match(job.cancelError ?? "", /not confirmed.*desktop service is unavailable/);
  reject = false;
  await store.getState().cancelJob();
  job = store.getState().job!;
  assert.deepEqual({ stopping: job.stopping, cancelError: job.cancelError, stopReason: job.stopReason }, { stopping: true, cancelError: null, stopReason: "cancelled" });
  assert.deepEqual(cancels, ["job-1", "job-1"]);
  await store.getState().cancelJob();
  assert.equal(cancels.length, 2, "a confirmed cancel is not resent");
  response.resolve({ stopped: true, results: [{ metricId: "metric", targetKind: "USER", targetId: "user", ok: false, status: "not_attempted" }] });
  await running;
  assert.equal(store.getState().job, null);
});

test("a cancel pressed before the next request reports its job is sent once that job reports in", async () => {
  const operations = Array.from({ length: 201 }, (_, index) => ({ metricId: `metric-${index}`, target: { kind: "USER" as const, id: "user" } }));
  const second = deferred<Awaited<ReturnType<RegistryApi["follow"]>>>();
  const reported = deferred<void>();
  let observeSecond: ((status: PulseMutationJobStatus) => void) | undefined;
  const cancels: string[] = [];
  let requests = 0;
  const store = fixture({
    follow: async (_context, batch, _owner, observe) => {
      if (++requests === 1) {
        observe?.(jobStatus("job-1", { total: 200 }));
        return { results: batch.map((operation) => ({ metricId: operation.metricId, targetKind: "USER" as const, targetId: "user", ok: true, status: "followed" as const })) };
      }
      observeSecond = observe;
      reported.resolve();
      return second.promise;
    },
    cancelJob: async (id) => { cancels.push(id); return jobStatus(id, { state: "stopping", stopReason: "cancelled" }); },
  });
  store.getState().setContext(draft().context, "A", session);
  const running = store.getState().follow("follow", operations, [], []);
  await reported.promise;
  await store.getState().cancelJob();
  assert.deepEqual(cancels, [], "no job id is known yet");
  assert.equal(store.getState().job?.cancelling, true);
  observeSecond!(jobStatus("job-2"));
  await settle();
  assert.deepEqual(cancels, ["job-2"], "the cancel reaches the request that was already sent");
  assert.equal(store.getState().job?.stopping, true);
  second.resolve({ stopped: true, results: [{ metricId: "metric-200", targetKind: "USER", targetId: "user", ok: false, status: "not_attempted" }] });
  await running;
  assert.equal(requests, 2);
});

test("a cancel pressed between requests keeps later requests from being sent even if the server is unreachable", async () => {
  const operations = Array.from({ length: 401 }, (_, index) => ({ metricId: `metric-${index}`, target: { kind: "USER" as const, id: "user" } }));
  const first = deferred<Awaited<ReturnType<RegistryApi["follow"]>>>();
  let requests = 0;
  const store = fixture({
    follow: async (_context, batch, _owner, observe) => {
      requests++;
      observe?.(jobStatus(`job-${requests}`, { total: 200 }));
      return requests === 1 ? first.promise : { results: batch.map((operation) => ({ metricId: operation.metricId, targetKind: "USER" as const, targetId: "user", ok: true, status: "followed" as const })) };
    },
    cancelJob: async () => { throw new Error("offline"); },
  });
  store.getState().setContext(draft().context, "A", session);
  const running = store.getState().follow("follow", operations, [], []);
  await settle();
  await store.getState().cancelJob();
  assert.match(store.getState().job?.cancelError ?? "", /offline/);
  first.resolve({ results: operations.slice(0, 200).map((operation) => ({ metricId: operation.metricId, targetKind: "USER" as const, targetId: "user", ok: true, status: "followed" as const })) });
  await running;
  assert.equal(requests, 1, "later requests are not started after Cancel");
  const results = store.getState().results!;
  assert.equal(results.items.filter((item) => item.status === "not_attempted").length, 201);
});

test("a cancel that reaches a job that already finished does not report a stop", async () => {
  const response = deferred<Awaited<ReturnType<RegistryApi["fork"]>>>();
  const store = fixture({
    fork: async (_context, _request, _owner, _options, observe) => { observe?.(jobStatus("job-1", { kind: "fork" })); return response.promise; },
    cancelJob: async (id) => jobStatus(id, { kind: "fork", state: "finished" }),
  });
  store.getState().setContext(draft().context, "A", session);
  const running = store.getState().fork({ version: 1, sourceMetricIds: ["metric"], timeframe: { key: "mtd" } } as any, new Map());
  await settle();
  await store.getState().cancelJob();
  const job = store.getState().job!;
  assert.deepEqual({ stopping: job.stopping, cancelling: job.cancelling, cancelError: job.cancelError, stopReason: job.stopReason }, { stopping: false, cancelling: false, cancelError: null, stopReason: null });
  response.resolve({ attempted: 1, created: 1, existing: 0, failed: 0, pendingVisibility: 0, results: [] });
  await running;
  assert.doesNotMatch(store.getState().results?.summary ?? "", /cancelled/, "a batch that completed is not described as cancelled");
});
