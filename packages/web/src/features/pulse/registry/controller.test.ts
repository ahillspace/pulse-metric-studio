import assert from "node:assert/strict";
import test from "node:test";
import type {
  PulseDeletePlan,
  PulseInventoryResponse,
  PulseVariantSummary,
} from "@pulse-metric-studio/shared";
import { createRegistryController } from "./controller";
import { deferred, draft, inventory } from "../testing/fixtures";
import { unavailableFollowState } from "../follow-state";
import type { RegistryApi } from "../api/registry";
import { PulseApiError, type PulseApi } from "../api/client";

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

test("selection-scoped follower refresh batches exact IDs and preserves inventory state", async () => {
  const requests: string[][] = [];
  const store = fixture({ followState: async (ids) => {
    requests.push(ids);
    if (ids.includes("m200")) throw new Error("subscription read failed");
    return { ...unavailableFollowState(ids, "partial"), selectedGroupId: null,
      groupFollowerIdsByMetricId: {}, groupContextUnavailable: false, availabilityByMetricId: {},
      userFollowerIdsByMetricId: Object.fromEntries(ids.map(id => [id, ["subscriber"]])) };
  } });
  store.getState().setContext(draft().context);
  const before = store.getState().followState;
  const ids = Array.from({length: 405}, (_, index) => `m${index}`);
  const result = await store.getState().refreshFollowState([...ids, "m0"]);
  assert.deepEqual(requests.flat(), ids);
  assert.deepEqual(requests.map(batch => batch.length), [200, 200, 5]);
  assert.deepEqual(result?.userFollowerIdsByMetricId?.m404, ["subscriber"]);
  assert.equal(result?.availabilityByMetricId?.m200.status, "unavailable");
  assert.equal(result?.userFollowerIdsByMetricId?.m200, undefined);
  assert.equal(store.getState().followState, before);
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
  const store = fixture(
    {},
    {
      previewDelete: async (input) => {
        previews.push(input.metricIds.length);
        assert.ok(input.metricIds.length <= 1000);
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
  await store.getState().previewDelete(ids, []);
  assert.equal(store.getState().deletePlan?.targets.length, 1001);
  await store.getState().executeDelete();
  assert.deepEqual(previews, [1000, 1]);
  assert.deepEqual(deleted, ids);
  assert.equal(store.getState().results?.items.length, 1001);
});

test("mixed bulk review removes covered children before splitting and retains earlier outcomes when a later plan changes", async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `variant-${index}`);
  let executions = 0;
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
    { inventory: async () => source },
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
  await store.getState().previewDelete(["child"], []);
  await store.getState().executeDelete();
  assert.deepEqual(previews, [
    {
      context,
      metricIds: ["child"],
      definitionIds: [],
      allowIncompleteInventory: false,
    },
  ]);
  assert.deepEqual(commands, [
    {
      context,
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

test("follow and unfollow invalidate their original datasource after navigation, including lost responses", async () => {
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
      assert.equal(store.getState().inventory, null);
      assert.equal(store.getState().results?.kind, kind);
      await store.getState().ensureLoaded();
      assert.deepEqual(reads, ["a", "b", "a"]);
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
