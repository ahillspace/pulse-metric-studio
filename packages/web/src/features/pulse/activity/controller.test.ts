import assert from "node:assert/strict";
import test from "node:test";
import { createActivityController } from "./controller";
import { deferred, receipt } from "../testing/fixtures";
import type {
  PulseDraftContext,
  PulsePublishReceipt,
  PulseReceiptPage,
} from "@pulse-metric-studio/shared";

test("group deletion refreshes the captured inventory on confirmed and lost responses", async () => {
  for (const lost of [false, true]) {
    const pending = deferred<PulsePublishReceipt>();
    const invalidated: PulseDraftContext[] = [];
    const store = createActivityController({
      listReceipts: async () => ({ receipts: [], total: 0, offset: 0, limit: 20 }),
      readReceipt: async (id) => receipt(id),
      undo: async (id) => receipt(id),
    }, () => pending.promise, (context) => { if (context) invalidated.push(context); });
    store.getState().received(receipt("a"));
    const deleting = store.getState().deleteGroup("a", "group");
    store.getState().close();
    if (lost) pending.reject(new Error("Response lost"));
    else pending.resolve(receipt("a"));
    await deleting;
    assert.deepEqual(invalidated, [receipt("a").context]);
    assert.equal(store.getState().groupError, lost ? "Response lost" : null);
  }
});

test("late receipt selection never replaces the most recently selected receipt", async () => {
  const first = deferred<PulsePublishReceipt>();
  const store = createActivityController({
    listReceipts: async () => ({
      receipts: [],
      total: 0,
      offset: 0,
      limit: 20,
    }),
    readReceipt: (id) =>
      id === "a" ? first.promise : Promise.resolve(receipt(id)),
    undo: async (id) => receipt(id),
  });
  const a = store.getState().open("a");
  await store.getState().open("b");
  first.resolve(receipt("a"));
  await a;
  assert.equal(store.getState().selected?.id, "b");
});

test("a receipt read started before undo cannot erase its confirmed outcome", async () => {
  const read = deferred<PulsePublishReceipt>();
  const removed = receipt();
  removed.items[0].undoStatus = "deleted";
  removed.undoEligible = false;
  const store = createActivityController({
    listReceipts: async () => ({
      receipts: [],
      total: 0,
      offset: 0,
      limit: 20,
    }),
    readReceipt: () => read.promise,
    undo: async () => removed,
  });
  const opening = store.getState().open("receipt");
  await store.getState().undo("receipt");
  read.resolve(receipt());
  await opening;
  assert.equal(store.getState().selected?.items[0].undoStatus, "deleted");
});

test("failed undo preserves the receipt and permits an explicit retry", async () => {
  let attempts = 0;
  const store = createActivityController({
    listReceipts: async () => ({
      receipts: [],
      total: 0,
      offset: 0,
      limit: 20,
    }),
    readReceipt: async () => receipt(),
    undo: async () => {
      if (++attempts === 1) throw new Error("Unavailable");
      return { ...receipt(), undoEligible: false };
    },
  });
  await store.getState().open("receipt");
  await store.getState().undo("receipt");
  assert.equal(store.getState().selected?.id, "receipt");
  assert.match(store.getState().error ?? "", /Unavailable/);
  assert.equal(store.getState().undoBusy, false);
  await store.getState().undo("receipt");
  assert.equal(attempts, 2);
  assert.equal(store.getState().selected?.undoEligible, false);
});

test("paged receipt search ignores an older list response", async () => {
  const old = deferred<PulseReceiptPage>();
  const queries: unknown[] = [];
  const store = createActivityController({
    listReceipts: async (query) => {
      queries.push(query);
      return query?.q === "old"
        ? old.promise
        : { receipts: [receipt("new")], total: 1, offset: 0, limit: 20 };
    },
    readReceipt: async () => receipt(),
    undo: async () => receipt(),
  });
  const loading = store.getState().load(20, "old");
  await store.getState().load(0, "new");
  old.resolve({ receipts: [receipt("old")], total: 80, offset: 20, limit: 20 });
  await loading;
  assert.equal(store.getState().receipts[0].id, "new");
  assert.equal(store.getState().total, 1);
  assert.deepEqual(queries, [
    { offset: 20, limit: 20, q: "old" },
    { offset: 0, limit: 20, q: "new" },
  ]);
});

test("undo failures remain attached to their publication for contextual rendering", async () => {
  const store = createActivityController({
    listReceipts: async () => ({
      receipts: [],
      total: 0,
      offset: 0,
      limit: 20,
    }),
    readReceipt: async (id) => receipt(id),
    undo: async () => {
      throw new Error("Tableau could not delete Sales");
    },
  });
  await store.getState().undo("failed-publication");
  assert.equal(store.getState().undoReceiptId, "failed-publication");
  assert.equal(store.getState().undoError, "Tableau could not delete Sales");
  await store.getState().load();
  assert.equal(store.getState().undoError, "Tableau could not delete Sales");
  assert.equal(store.getState().undoBusy, false);
});

test("history refresh returns to an available page when the inventory shrinks", async () => {
  const offsets: number[] = [];
  const store = createActivityController({
    listReceipts: async (query) => {
      const offset = query?.offset ?? 0;
      offsets.push(offset);
      return {
        receipts: offset ? [] : [receipt()],
        total: 1,
        offset,
        limit: 20,
      };
    },
    readReceipt: async () => receipt(),
    undo: async () => receipt(),
  });
  await store.getState().load(20);
  assert.deepEqual(offsets, [20, 0]);
  assert.equal(store.getState().offset, 0);
  assert.equal(store.getState().receipts.length, 1);
});

test("receipt refresh failures remain attached to that publication and clear on retry", async () => {
  let fail = true;
  const store = createActivityController({
    listReceipts: async () => ({
      receipts: [],
      total: 0,
      offset: 0,
      limit: 20,
    }),
    readReceipt: async (id) => {
      if (fail) throw new Error("Could not refresh results");
      return receipt(id);
    },
    undo: async () => receipt(),
  });
  await store.getState().open("publication");
  await store.getState().load();
  assert.equal(store.getState().readReceiptId, "publication");
  assert.equal(store.getState().readError, "Could not refresh results");
  fail = false;
  await store.getState().open("publication");
  assert.equal(store.getState().readError, null);
});

test("publication group deletion updates its receipt without replacing a later selection", async () => {
  const pending = deferred<PulsePublishReceipt>();
  const store = createActivityController(
    {
      listReceipts: async () => ({
        receipts: [],
        total: 0,
        offset: 0,
        limit: 20,
      }),
      readReceipt: async (id) => receipt(id),
      undo: async (id) => receipt(id),
    },
    async () => pending.promise,
  );
  await store.getState().open("a");
  const deleting = store.getState().deleteGroup("a", "group");
  store.getState().close();
  const removed = receipt("a");
  removed.follow.group = {
    status: "created",
    id: "group",
    deletion: { status: "deleted" },
  };
  pending.resolve(removed);
  await deleting;
  assert.equal(store.getState().selected, null);
  assert.equal(store.getState().groupBusy, false);
});

test("latest publication receipt remains available to Author after selecting or closing other Activity details", async () => {
  const changed = receipt("a");
  changed.follow.group = {
    status: "created",
    id: "group",
    deletion: { status: "deleted" },
  };
  const store = createActivityController(
    {
      listReceipts: async () => ({
        receipts: [],
        total: 0,
        offset: 0,
        limit: 20,
      }),
      readReceipt: async (id) => receipt(id),
      undo: async (id) => receipt(id),
    },
    async () => changed,
  );
  await store.getState().deleteGroup("a", "group");
  await store.getState().open("b");
  assert.equal(
    store.getState().receiptById.a.follow.group.deletion?.status,
    "deleted",
  );
  store.getState().close();
  assert.equal(
    store.getState().receiptById.a.follow.group.deletion?.status,
    "deleted",
  );
});
