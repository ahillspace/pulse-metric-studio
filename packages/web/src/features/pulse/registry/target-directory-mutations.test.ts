import assert from "node:assert/strict";
import test from "node:test";
import { createRegistryController, useRegistry } from "./controller";
import { createAuthorController, useAuthor } from "../author/controller";
import { createActivityController, useActivity } from "../activity/controller";
import { useConnection } from "../connections/controller";
import { unavailableFollowState } from "../follow-state";
import { catalog, deferred, draft, inventory, receipt, session } from "../testing/fixtures";
import { registryApi, type RegistryApi } from "../api/registry";
import { pulseApi } from "../api/client";
import type { PulsePublishReceipt } from "@pulse-metric-studio/shared";
import type { SessionOwner } from "../shell/session-events";

function fixture(first?: ReturnType<RegistryApi["followTargets"]>) {
  let reads = 0;
  let names = ["Existing"];
  const registry = createRegistryController({
    inventory: async () => inventory(),
    followState: async (ids) => ({ ...unavailableFollowState(ids, "test"), selectedGroupId: null, groupContextUnavailable: false,
      groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {} }),
    followTargets: async () => {
      reads++;
      if (reads === 1 && first) return first;
      return { targets: names.map(name => ({ id: name, name, kind: "GROUP" as const })), errors: [] };
    },
    followers: async () => ({ details: [] }), follow: async () => ({ results: [] }), unfollow: async () => ({ results: [] }),
    fork: async () => ({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] }),
  });
  registry.getState().setContext(draft().context, "A", session);
  const changed = (_context: unknown, owner: SessionOwner | null, directoryChanged: boolean) => {
    if (directoryChanged) registry.getState().invalidateTargets(owner);
  };
  return { registry, changed, get reads() { return reads; }, setNames(next: string[]) { names = next; } };
}
function authorFixture(changed: ReturnType<typeof fixture>["changed"], publish: () => Promise<PulsePublishReceipt>, groupFollow = true) {
  const record = draft();
  return createAuthorController({
    readDraft: async () => record,
    preview: async (_id: string, revision: number) => ({ draftId: record.id, revision, context: record.context, datasourceName: "A",
      previewFingerprint: "reviewed", metrics: [{ ...receipt().items[0].summary, name: "Revenue", description: "" }], digestAudience: "Audience", followMode: groupFollow ? "group" : "none", issues: [] }),
    publish,
  } as any, async () => ({ catalog: catalog() }), () => session, () => {}, 60_000, changed);
}

for (const outcome of ["created", "unknown", "lost", "reused", "skipped"] as const) {
  test(`publication ${outcome} invalidates directory only when group creation may have changed it`, async (t) => {
    const f = fixture();
    await f.registry.getState().loadTargets();
    const mayChange = ["created", "unknown", "lost"].includes(outcome);
    const author = authorFixture(f.changed, async () => {
      if (mayChange) f.setNames(["Existing", "New group"]);
      if (outcome === "lost") throw new Error("Response lost");
      const published = receipt();
      published.follow.requested = outcome !== "skipped";
      published.follow.mode = outcome === "skipped" ? "none" : "group";
      published.follow.group = { status: outcome, ...(outcome !== "skipped" ? { id: "new-group" } : {}) };
      return published;
    }, outcome !== "skipped");
    t.after(() => author.getState().dispose());
    await author.getState().openDraft("a");
    await author.getState().reviewPublication();
    await author.getState().publishReviewed();
    const reopened = await f.registry.getState().loadTargets();
    assert.equal(f.reads, mayChange ? 2 : 1);
    assert.equal(reopened.targets.some(target => target.name === "New group"), mayChange);
  });
}

for (const outcome of ["deleted", "unknown", "lost"] as const) {
  test(`Activity group deletion ${outcome} invalidates captured owner's choices`, async (t) => {
    const original = useConnection.getState();
    t.after(() => useConnection.setState(original, true));
    useConnection.setState({ session });
    const f = fixture();
    await f.registry.getState().loadTargets();
    const activity = createActivityController({} as any, async () => {
      f.setNames([]);
      if (outcome === "lost") throw new Error("Response lost");
      const result = receipt();
      result.follow.group = { status: "created", id: "group", deletion: { status: outcome } };
      return result;
    }, f.changed);
    activity.getState().received(receipt());
    await activity.getState().deleteGroup("receipt", "group");
    const reopened = await f.registry.getState().loadTargets();
    assert.equal(f.reads, 2);
    assert.equal(reopened.targets.length, 0);
  });
}

test("a pending directory read cannot repopulate after the actual publication callback", async (t) => {
  const old = deferred<Awaited<ReturnType<RegistryApi["followTargets"]>>>();
  const f = fixture(old.promise);
  const first = f.registry.getState().loadTargets();
  const author = authorFixture(f.changed, async () => {
    f.setNames(["New group"]);
    const published = receipt(); published.follow.group = { status: "created", id: "new-group" }; return published;
  });
  t.after(() => author.getState().dispose());
  await author.getState().openDraft("a"); await author.getState().reviewPublication(); await author.getState().publishReviewed();
  const fresh = f.registry.getState().loadTargets();
  try { assert.equal(f.reads, 2); }
  finally { old.resolve({ targets: [{ id: "old", name: "Old group", kind: "GROUP" }], errors: [] }); await Promise.all([first, fresh]); }
  assert.deepEqual((await f.registry.getState().loadTargets()).targets.map(target => target.name), ["New group"]);
});

test("ordinary metric follow keeps the valid directory cached", async () => {
  const f = fixture();
  await f.registry.getState().loadTargets();
  await f.registry.getState().follow("follow", [{ metricId: "metric", target: { kind: "USER", id: session.userId } }], [], []);
  await f.registry.getState().loadTargets();
  assert.equal(f.reads, 1);
});

test("late Activity callback invalidates its captured owner without touching a replacement directory", async (t) => {
  const original = useConnection.getState(); t.after(() => useConnection.setState(original, true));
  useConnection.setState({ session });
  const f = fixture(); await f.registry.getState().loadTargets();
  const pending = deferred<PulsePublishReceipt>();
  const activity = createActivityController({} as any, () => pending.promise, f.changed);
  activity.getState().received(receipt());
  const deleting = activity.getState().deleteGroup("receipt", "group");
  const next = { ...session, sessionGeneration: 2, userId: "other" };
  useConnection.setState({ session: next });
  f.registry.getState().setContext(draft().context, "A", next);
  await f.registry.getState().loadTargets();
  const result = receipt(); result.follow.group = { status: "created", id: "group", deletion: { status: "deleted" } };
  pending.resolve(result); await deleting;
  await f.registry.getState().loadTargets(); assert.equal(f.reads, 2, "new owner directory remains cached");
  f.registry.getState().setContext(draft().context, "A", session);
  await f.registry.getState().loadTargets(); assert.equal(f.reads, 3, "the original owner directory was invalidated");
});

test("the actual application Author and Activity wiring invalidates directory choices", async (t) => {
  const originals = [useRegistry.getState(), useAuthor.getState(), useActivity.getState(), useConnection.getState()] as const;
  t.after(() => {
    useRegistry.setState(originals[0], true); useAuthor.setState(originals[1], true);
    useActivity.setState(originals[2], true); useConnection.setState(originals[3], true);
  });
  const owner = { ...session, sessionGeneration: 777 };
  useConnection.setState({ session: owner });
  useRegistry.getState().setContext(draft().context, "A", owner);
  let names = ["Existing"];
  let directoryReads = 0;
  t.mock.method(registryApi, "followTargets", async () => {
    directoryReads++;
    return { targets: names.map(name => ({ kind: "GROUP" as const, id: name, name })), errors: [] };
  });
  t.mock.method(registryApi, "inventory", async () => inventory());
  t.mock.method(registryApi, "followState", async (ids: string[]) => ({ ...unavailableFollowState(ids, "test"), selectedGroupId: null,
    groupContextUnavailable: false, groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, availabilityByMetricId: {} }));
  await useRegistry.getState().loadTargets();
  const published = receipt(); published.follow.group = { status: "created", id: "new-group" };
  const local = authorFixture(() => {}, async () => published);
  t.after(() => local.getState().dispose());
  await local.getState().openDraft("a"); await local.getState().reviewPublication();
  useAuthor.setState({ activeId: "a", entries: local.getState().entries });
  t.mock.method(pulseApi, "publish", async () => { names = ["Existing", "New group"]; return published; });
  await useAuthor.getState().publishReviewed();
  await useRegistry.getState().ensureLoaded();
  assert.equal((await useRegistry.getState().loadTargets()).targets.some(target => target.name === "New group"), true);
  assert.equal(directoryReads, 2);
  // The Activity singleton captured the API function at construction, so its
  // real transport is intercepted at the fetch boundary for this action.
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    names = ["Existing"];
    return Response.json({ ...published, follow: { ...published.follow, group: { ...published.follow.group, deletion: { status: "deleted" } } } });
  };
  useActivity.getState().received(published);
  await useActivity.getState().deleteGroup(published.id, "new-group");
  await useRegistry.getState().ensureLoaded();
  assert.equal((await useRegistry.getState().loadTargets()).targets.some(target => target.name === "New group"), false);
  assert.equal(directoryReads, 3);
});
