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

test("an authentication rejection expires only its captured session owner", async () => {
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: async () => ({ ok: true }),
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().connected(session, session.connectionId);
  const old = { ...store.getState().session! };
  await store.getState().connected({ ...session, sessionGeneration: 2 }, session.connectionId);
  store.getState().expireSession(old);
  assert.equal(store.getState().session?.sessionGeneration, 2);
  store.getState().expireSession({ ...session, sessionGeneration: 2 });
  assert.equal(store.getState().session, null);
});

test("temporary status unavailability retains authentication and communicates retry", async () => {
  const store = createConnectionController({
    status: async () => ({ connected: true, session, reachable: false, availabilityError: "Tableau is temporarily unavailable." }),
    disconnect: async () => ({ ok: true }),
    datasources: async () => { throw new Error("must not load during temporary unavailability"); },
  });
  await store.getState().init();
  assert.equal(store.getState().session?.userId, session.userId);
  assert.equal(store.getState().reachable, false);
  assert.match(store.getState().error ?? "", /temporarily unavailable/);
});

test("permission refresh updates only current owner metadata without datasource scans", async () => {
  let sources = 0;
  const store = createConnectionController({
    status: async () => ({ connected: true, session: { ...session, groupCreation: { state: "allowed", reasonCode: "test", message: "Group creation is available." } } as any }),
    disconnect: async () => ({ ok: true }), datasources: async () => { sources++; return { datasources: [] }; },
  });
  await store.getState().connected(session, session.connectionId);
  await (store.getState() as any).refreshAccess();
  assert.equal(sources, 1);
  assert.equal((store.getState().session as any).groupCreation.state, "allowed");
});

test("late permission refresh cannot replace a newer authenticated owner", async () => {
  const held = deferred<any>();
  const store = createConnectionController({ status: () => held.promise, disconnect: async () => ({ ok: true }), datasources: async () => ({ datasources: [] }) });
  await store.getState().connected(session, session.connectionId);
  const checking = (store.getState() as any).refreshAccess();
  await store.getState().connected({ ...session, userId: "new-user", sessionGeneration: 2 }, session.connectionId);
  held.resolve({ connected: true, session: { ...session, groupCreation: { state: "allowed", reasonCode: "test", message: "Allowed" } } });
  await checking;
  assert.equal(store.getState().session?.userId, "new-user");
  assert.equal((store.getState().session as any).groupCreation?.state, undefined);
});

test("permission checks cannot silently adopt another backend owner or clear authentication on failure", async () => {
  for (const failure of ["switched", "unavailable"] as const) {
    let sources = 0;
    const store = createConnectionController({
      status: async () => { if (failure === "unavailable") throw new Error("Temporary status failure"); return { connected: true, session: { ...session, userId: "other", sessionGeneration: 2 } }; },
      disconnect: async () => ({ ok: true }), datasources: async () => { sources++; return { datasources: [] }; },
    });
    await store.getState().connected(session, session.connectionId);
    await store.getState().refreshAccess();
    assert.equal(store.getState().session?.userId, session.userId);
    assert.equal(store.getState().session?.groupCreation?.state, "unknown");
    assert.equal(store.getState().reachable, true);
    assert.equal(store.getState().accessChecking, false);
    assert.equal(sources, 1);
  }
});

for (const result of ["unknown", "legacy", "mismatched", "failed"] as const) {
  test(`permission refresh clears stale verified role after ${result} verification`, async () => {
    let sources = 0;
    const choices = [{ luid: "datasource", name: "Preserved datasource", projectName: "Project" }];
    const store = createConnectionController({
      status: async () => {
        if (result === "failed") throw new Error("Permission verification unavailable");
        return { connected: true, session: { ...session,
          ...(result === "mismatched" ? { userId: "other-user" } : {}),
          ...(result === "unknown" ? { groupCreation: { state: "unknown" as const, reasonCode: "profile_unavailable", message: "Not verified" } } : {}),
        } };
      },
      disconnect: async () => ({ ok: true }),
      datasources: async () => { sources++; return { datasources: choices }; },
    });
    await store.getState().connected({ ...session, userName: "Preserved account", siteRole: "SiteAdministratorCreator",
      groupCreation: { state: "allowed", reasonCode: "verified", message: "Allowed" } }, session.connectionId);
    const before = store.getState();
    await store.getState().refreshAccess();
    const after = store.getState();
    assert.equal(after.session?.siteRole, undefined, "unverified metadata must not keep the previous admin claim");
    assert.equal(after.session?.groupCreation?.state, "unknown");
    assert.equal(after.session?.userId, session.userId);
    assert.equal(after.session?.sessionGeneration, session.sessionGeneration);
    assert.equal(after.session?.userName, "Preserved account");
    assert.equal(after.datasources, before.datasources);
    assert.equal(after.checked, before.checked);
    assert.equal(after.reachable, before.reachable);
    assert.equal(after.accessChecking, false);
    assert.equal(sources, 1, "permission verification must not reload navigation choices");
  });
}

test("permission refresh preserves a pending datasource response", async () => {
  const pending = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
  let calls = 0;
  const store = createConnectionController({
    status: async () => ({ connected: true, session: { ...session, siteRole: "Creator" } }),
    disconnect: async () => ({ ok: true }),
    datasources: () => { calls++; return pending.promise; },
  });
  const connecting = store.getState().connected(session, session.connectionId);
  await store.getState().refreshAccess();
  pending.resolve({ datasources: [{ luid: "one", name: "One", projectName: "" }] });
  await connecting;
  assert.equal(calls, 1);
  assert.equal(store.getState().datasources[0]?.luid, "one");
  assert.equal(store.getState().loadingDatasources, false);
});

for (const outcome of ["success", "failure"] as const) {
  test(`permission refresh preserves a pending disconnect ${outcome}`, async () => {
    const pending = deferred<{ ok: true }>();
    const store = createConnectionController({
      status: async () => ({ connected: true, session: { ...session, siteRole: "Creator" } }),
      disconnect: () => pending.promise,
      datasources: async () => ({ datasources: [{ luid: "one", name: "One", projectName: "" }] }),
    });
    await store.getState().connected(session, session.connectionId);
    const disconnecting = store.getState().disconnect();
    await store.getState().refreshAccess();
    if (outcome === "success") pending.resolve({ ok: true });
    else pending.reject(new Error("Disconnect failed"));
    await disconnecting;
    assert.equal(store.getState().connecting, false);
    assert.equal(store.getState().accessChecking, false);
    if (outcome === "success") {
      assert.equal(store.getState().session, null);
      assert.deepEqual(store.getState().datasources, []);
    } else {
      assert.equal(store.getState().session?.userId, session.userId);
      assert.match(store.getState().error ?? "", /Disconnect failed/);
    }
  });
}

test("disconnect retires a pending permission refresh", async () => {
  const pending = deferred<any>();
  const store = createConnectionController({
    status: () => pending.promise,
    disconnect: async () => ({ ok: true }),
    datasources: async () => ({ datasources: [] }),
  });
  await store.getState().connected(session, session.connectionId);
  const checking = store.getState().refreshAccess();
  await store.getState().disconnect();
  assert.equal(store.getState().session, null);
  assert.equal(store.getState().accessChecking, false);
  pending.resolve({ connected: true, session: { ...session, siteRole: "Creator" } });
  await checking;
  assert.equal(store.getState().session, null);
  assert.equal(store.getState().accessChecking, false);
});

for (const replacement of [{ ...session, userId: "new-user" }, { ...session, sessionGeneration: 2 }]) {
  for (const outcome of ["success", "failure"] as const) {
    test(`old operations cannot affect a replacement owner (${replacement.userId}, ${replacement.sessionGeneration}, ${outcome})`, async () => {
      const sources = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
      const disconnect = deferred<{ ok: true }>();
      let calls = 0;
      const store = createConnectionController({
        status: async () => ({ connected: true, session }),
        disconnect: () => disconnect.promise,
        datasources: () => ++calls === 1 ? sources.promise : Promise.resolve({ datasources: [{ luid: "new", name: "New", projectName: "" }] }),
      });
      const connecting = store.getState().connected(session, session.connectionId);
      const disconnecting = store.getState().disconnect();
      await store.getState().connected(replacement, replacement.connectionId);
      if (outcome === "success") {
        sources.resolve({ datasources: [{ luid: "old", name: "Old", projectName: "" }] });
        disconnect.resolve({ ok: true });
      } else {
        sources.reject(new Error("Old datasource failure"));
        disconnect.reject(new Error("Old disconnect failure"));
      }
      await Promise.all([connecting, disconnecting]);
      assert.equal(store.getState().session?.userId, replacement.userId);
      assert.equal(store.getState().session?.sessionGeneration, replacement.sessionGeneration);
      assert.equal(store.getState().datasources[0]?.luid, "new");
      assert.equal(store.getState().error, null);
      assert.equal(store.getState().loadingDatasources, false);
      assert.equal(store.getState().connecting, false);
      assert.equal(calls, 2);
    });
  }
}


test("permission refresh preserves a pending datasource error", async () => {
  const pending = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
  const store = createConnectionController({
    status: async () => ({ connected: true, session: { ...session, siteRole: "Creator" } }),
    disconnect: async () => ({ ok: true }),
    datasources: () => pending.promise,
  });
  const connecting = store.getState().connected(session, session.connectionId);
  await store.getState().refreshAccess();
  pending.reject(new Error("Datasource failed"));
  await connecting;
  assert.match(store.getState().error ?? "", /Datasource failed/);
  assert.equal(store.getState().loadingDatasources, false);
});

for (const result of ["throws", "unreachable", "disconnected"] as const) {
  test(`status retry retires a pending datasource load when status ${result}`, async () => {
    const pending = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
    const store = createConnectionController({
      status: async () => {
        if (result === "throws") throw new Error("Status unavailable");
        if (result === "unreachable") return { connected: true, session, reachable: false };
        return { connected: false };
      },
      disconnect: async () => ({ ok: true }),
      datasources: () => pending.promise,
    });
    const connecting = store.getState().connected(session, session.connectionId);
    assert.equal(store.getState().loadingDatasources, true);
    await store.getState().init();
    assert.equal(store.getState().loadingDatasources, false);
    pending.resolve({ datasources: [{ luid: "old", name: "Old", projectName: "" }] });
    await connecting;
    assert.deepEqual(store.getState().datasources, []);
    assert.equal(store.getState().loadingDatasources, false);
  });
}

test("a retired datasource completion cannot clear a subsequent load indicator", async () => {
  const old = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
  const current = deferred<{ datasources: Array<{ luid: string; name: string; projectName: string }> }>();
  let calls = 0;
  const store = createConnectionController({
    status: async () => ({ connected: true, session }),
    disconnect: async () => ({ ok: true }),
    datasources: () => ++calls === 1 ? old.promise : current.promise,
  });
  const connecting = store.getState().connected(session, session.connectionId);
  const initializing = store.getState().init();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(store.getState().loadingDatasources, true);
  old.resolve({ datasources: [{ luid: "old", name: "Old", projectName: "" }] });
  await connecting;
  assert.equal(store.getState().loadingDatasources, true);
  assert.deepEqual(store.getState().datasources, []);
  current.resolve({ datasources: [{ luid: "new", name: "New", projectName: "" }] });
  await initializing;
  assert.equal(store.getState().loadingDatasources, false);
  assert.equal(store.getState().datasources[0]?.luid, "new");
});

test("startup loads datasources when profile access is unknown but Tableau is reachable", async () => {
  let sourceCalls = 0;
  const unknown = { state: "unknown" as const, reasonCode: "profile_unavailable", message: "Group creation permission is not verified." };
  const store = createConnectionController({
    status: async () => ({ connected: true, reachable: true, session: { ...session, groupCreation: unknown } }),
    disconnect: async () => ({ ok: true }),
    datasources: async () => { sourceCalls++; return { datasources: [{ luid: "one", name: "One", projectName: "Project" }] }; },
  });
  await store.getState().init();
  assert.equal(sourceCalls, 1);
  assert.equal(store.getState().session?.userId, session.userId);
  assert.deepEqual(store.getState().session?.groupCreation, unknown);
  assert.equal(store.getState().reachable, true);
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().datasources[0]?.luid, "one");
  assert.equal(store.getState().loadingDatasources, false);
});
