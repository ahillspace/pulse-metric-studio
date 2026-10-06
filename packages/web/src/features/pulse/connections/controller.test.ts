import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionController } from "./controller";
import { deferred, session } from "../testing/fixtures";

test("an old datasource lookup cannot replace a new connection", async () => {
  const first = deferred<{
    datasources: Array<{ luid: string; name: string; projectName: string }>;
  }>();
  let calls = 0;
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: async () => ({ ok: true }),
    datasources: async () =>
      ++calls === 1
        ? first.promise
        : { datasources: [{ luid: "new", name: "New", projectName: "" }] },
  });
  const connecting = store.getState().connected(session, "a");
  await store.getState().connected({ ...session, siteId: "new-site" }, "b");
  first.resolve({
    datasources: [{ luid: "old", name: "Old", projectName: "" }],
  });
  await connecting;
  assert.equal(store.getState().session?.connectionId, "b");
  assert.equal(store.getState().datasources[0].luid, "new");
});

test("disconnect completion cannot clear a newer connection", async () => {
  const disconnect = deferred<{ ok: true }>();
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: () => disconnect.promise,
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().connected(session, "a");
  const disconnecting = store.getState().disconnect();
  await store.getState().connected(session, "b");
  disconnect.resolve({ ok: true });
  await disconnecting;
  assert.equal(store.getState().session?.connectionId, "b");
});

test("expired authentication clears remote choices and shows a reconnect message", async () => {
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: async () => ({ ok: true }),
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().init();
  store.getState().expireSession();
  assert.equal(store.getState().session, null);
  assert.deepEqual(store.getState().datasources, []);
  assert.match(store.getState().error ?? "", /Reconnect/);
});
