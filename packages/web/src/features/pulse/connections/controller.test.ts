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
  assert.equal(store.getState().connecting, true);
  assert.equal(store.getState().startAction(), false);
  await store.getState().connected(session, "b");
  disconnect.resolve({ ok: true });
  await disconnecting;
  assert.equal(store.getState().session?.connectionId, "b");
  assert.equal(store.getState().connecting, false);
});

test("disconnect sends its captured session identity and rejects overlapping UI actions", async () => {
  const pending = deferred<{ ok: true }>();
  const owners: unknown[] = [];
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: (owner) => { owners.push(owner); return pending.promise; },
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().connected(session, session.connectionId);
  const disconnecting = store.getState().disconnect();
  await store.getState().disconnect();
  assert.deepEqual(owners, [{ connectionId: session.connectionId, sessionGeneration: session.sessionGeneration }]);
  assert.equal(store.getState().startAction(), false);
  pending.resolve({ ok: true });
  await disconnecting;
  assert.equal(store.getState().session, null);
  assert.equal(store.getState().connecting, false);
  assert.equal(store.getState().startAction(), true);
  store.getState().finishAction();
});

test("disconnect cannot overlap activation and a rejected disconnect remains retryable", async () => {
  let requests = 0;
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: async () => {
      if (++requests === 1) throw new Error('The active session changed.');
      return { ok: true };
    },
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().connected(session, session.connectionId);
  assert.equal(store.getState().startAction(), true);
  await store.getState().disconnect();
  assert.equal(requests, 0);
  store.getState().finishAction();
  await store.getState().disconnect();
  assert.equal(store.getState().session?.connectionId, session.connectionId);
  assert.equal(store.getState().connecting, false);
  assert.match(store.getState().error ?? '', /session changed/);
  await store.getState().disconnect();
  assert.equal(store.getState().session, null);
  assert.equal(requests, 2);
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
