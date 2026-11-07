import assert from "node:assert/strict";
import test from "node:test";
import { pulseRequest, pulseApi, PulseApiError } from "./client";
import { pulseDimensionalForkApi } from "../dimensional-fork-api";
import { registryApi } from "./registry";
import { useConnection } from "../connections/controller";
import { deferred, draft, inventory, receipt, session } from "../testing/fixtures";
import type { SessionOwner } from "../shell/session-events";

test("structured workflow errors retain status, message, code, and conflict details", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const nested of [false, true]) {
    const body = {
      message: "Draft changed in another window",
      code: "draft_revision_conflict",
      details: { currentRevision: 7 },
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(nested ? { error: body } : body), {
        status: 409,
      });
    await assert.rejects(
      pulseRequest("/api/pulse/drafts/example", "PUT", {}),
      (error: unknown) => {
        assert.ok(error instanceof PulseApiError);
        assert.equal(error.message, body.message);
        assert.equal(error.status, 409);
        assert.equal(error.code, body.code);
        assert.deepEqual(error.details, body.details);
        return true;
      },
    );
  }
});

test("dimension discovery sends complete large selections in POST bodies", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const sourceMetricIds = Array.from({ length: 1000 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const requests: Array<{ path: string; body: unknown }> = [];
  const fieldId = "Country/Region";
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    const path = String(input);
    requests.push({ path, body: JSON.parse(String(init.body)) });
    return Response.json(path.endsWith("/count") ? { fieldId, count: 2 }
      : path.endsWith("/values") ? { fieldId, values: [], truncated: false }
        : { fields: [] });
  };
  await pulseDimensionalForkApi.fields(sourceMetricIds);
  await pulseDimensionalForkApi.count(sourceMetricIds, fieldId);
  await pulseDimensionalForkApi.values(sourceMetricIds, fieldId, "West", { all: true });
  assert.deepEqual(requests, [
    { path: "/api/pulse/dimensions", body: { sourceMetricIds } },
    { path: "/api/pulse/dimensions/count", body: { sourceMetricIds, fieldId } },
    { path: "/api/pulse/dimensions/values", body: { sourceMetricIds, fieldId, search: "West", all: true } },
  ]);
});

test("late ordinary and receipt authentication failures retain a replacement session", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalConnection = useConnection.getState();
  t.after(() => {
    globalThis.fetch = originalFetch;
    useConnection.setState(originalConnection, true);
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  events.addEventListener("pulse-session-expired", (event) => {
    useConnection.getState().expireSession((event as CustomEvent<SessionOwner>).detail);
  });
  for (const kind of ["ordinary", "follow", "variant"] as const) {
    const pending = deferred<Response>();
    globalThis.fetch = () => pending.promise;
    useConnection.setState({ session });
    const request = kind === "ordinary" ? pulseRequest("/api/pulse/example").catch(() => null)
      : kind === "follow" ? registryApi.follow(draft().context, [])
        : registryApi.fork(draft().context, { version: 1, sourceMetricIds: ["metric"], timeframe: { key: "mtd" } } as any);
    const next = { ...session, sessionGeneration: session.sessionGeneration + 1, userId: "replacement-user" };
    useConnection.setState({ session: next });
    const body = kind === "variant" ? { terminated: true, attempted: 1, created: 0, existing: 0, failed: 1, pendingVisibility: 0, results: [] }
      : kind === "follow" ? { terminated: true, results: [] } : { message: "Authentication rejected" };
    pending.resolve(Response.json(body, { status: kind === "ordinary" ? 401 : 200 }));
    await request;
    assert.equal(useConnection.getState().session?.userId, "replacement-user", kind);
    // A definitive rejection of the same current session still expires it.
    globalThis.fetch = async () => Response.json({ message: "Authentication rejected" }, { status: 401 });
    await pulseRequest("/api/pulse/example").catch(() => null);
    assert.equal(useConnection.getState().session, null, kind);
  }
});

test("registry requests carry their immutable backend owner through query transport", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalConnection = useConnection.getState();
  t.after(() => { globalThis.fetch = originalFetch; useConnection.setState(originalConnection, true); });
  useConnection.setState({ session: { ...session, userId: "replacement", sessionGeneration: 2 } });
  const owners: unknown[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://app.example.test");
    assert.ok(String(input).length < 16 * 1024, "owner query remains within native path bounds");
    owners.push(JSON.parse(url.searchParams.get("expectedOwner")!));
    const path = url.pathname;
    if (path.endsWith("existing-metrics")) return Response.json(inventory());
    if (path.endsWith("follow-state")) return Response.json({ userFollowsByMetricId: {}, groupFollowsByMetricId: {}, groupFollowerIdsByMetricId: {}, userFollowerIdsByMetricId: {}, followerCountsByMetricId: {}, availabilityByMetricId: {}, selectedGroupId: null, groupContextUnavailable: false, errors: [] });
    if (path.endsWith("follow-targets")) return Response.json({ targets: [], errors: [] });
    if (path.endsWith("followers-detail")) return Response.json({ details: [] });
    if (path.endsWith("fork")) return Response.json({ attempted: 0, created: 0, existing: 0, failed: 0, pendingVisibility: 0, results: [] });
    return Response.json({ results: [] });
  };
  await registryApi.inventory(draft().context, session);
  await registryApi.followState(["metric"], false, session);
  await registryApi.followTargets(session);
  await registryApi.followers(["metric"], session);
  await registryApi.follow(draft().context, [], session);
  await registryApi.unfollow(draft().context, [], session);
  await registryApi.fork(draft().context, { version: 1, sourceMetricIds: ["metric"], clauses: [] }, session);
  const { connectionId, sessionGeneration, serverUrl, siteId, userId } = session;
  assert.equal(owners.length, 7);
  for (const owner of owners) assert.deepEqual(owner, { connectionId, sessionGeneration, serverUrl, siteId, userId });
});


test("local throttle refusals retain timing and sent evidence for buffered mutation UI", async (t) => {
  const throttle = { retryAt: 36_000, serverTime: 0, reason: "throttle", sent: false };
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Tableau is limiting requests", throttle }, { status: 429 }));
  for (const request of [
    () => pulseRequest("/api/pulse/delete", "POST", {}),
    () => registryApi.fork(draft().context, { version: 1, sourceMetricIds: ["metric"], clauses: [] }),
    () => registryApi.follow(draft().context, [{ metricId: "metric", target: { id: "user", kind: "USER" } }]),
  ]) await assert.rejects(request(), error => {
    assert.ok(error instanceof PulseApiError); assert.equal(error.status, 429); assert.deepEqual(error.throttle, throttle); return true;
  });
});


test("valid delete and subscription receipts preserve sent throttle metadata", async (t) => {
  const throttle = { retryAt: 40_000, serverTime: 0, reason: "throttle", sent: true };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => Response.json(String(input).endsWith("/registry/delete") ? {
    definitionsDeleted: 0, metricsDeleted: 0, failures: ["HTTP 429"], outcomes: [{ metricId: "metric", status: "failed", sent: true }], throttle,
  } : { results: [{ metricId: "metric", targetId: "user", targetKind: "USER", status: "failed", ok: false }], throttle }));
  const subscription = await registryApi.follow(draft().context, [{ metricId: "metric", target: { kind: "USER", id: "user" } }]);
  assert.deepEqual(subscription.throttle, throttle);
  const deleted = await pulseApi.delete({ context: draft().context, snapshotId: "snapshot", metricIds: ["metric"], definitionIds: [], previewFingerprint: "reviewed", allowIncompleteInventory: false });
  assert.deepEqual(deleted.throttle, throttle);
});

test("cancel resolves only on the server's confirmation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const job = (state: string) => ({ job: { id: "job", kind: "follow", state, total: 2, completed: 1, throttled: true, retryAt: null, serverTime: 0, stopReason: state === "running" ? null : "cancelled" } });
  globalThis.fetch = async () => Response.json(job("stopping"));
  assert.equal((await registryApi.cancelJob("job", null)).state, "stopping");
  globalThis.fetch = async () => Response.json(job("finished"));
  assert.equal((await registryApi.cancelJob("job", null)).state, "finished");
  for (const [label, respond] of [
    ["unreachable", async () => { throw new TypeError("fetch failed"); }],
    ["server error", async () => Response.json({ message: "Internal failure" }, { status: 500 })],
    ["unknown job", async () => Response.json({ code: "job_not_found", message: "This batch is no longer running." }, { status: 404 })],
    ["still running", async () => Response.json(job("running"))],
    ["malformed", async () => Response.json({ ok: true })],
  ] as const) {
    globalThis.fetch = respond as typeof fetch;
    await assert.rejects(registryApi.cancelJob("job", null), label);
  }
});

test("publish, undo, and group deletion follow their jobs to the final receipt", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const job = (kind: string) => ({ job: { id: `${kind}-job`, kind, state: "running", total: 2, completed: 1, throttled: true, retryAt: null, serverTime: 0, stopReason: null } });
  const requests = [
    { kind: "publish", path: "/api/pulse/drafts/draft/publish", body: { commandId: "receipt", expectedRevision: 1, previewFingerprint: "reviewed" }, send: (observe: (status: unknown) => void) => pulseApi.publish("draft", { commandId: "receipt", expectedRevision: 1, previewFingerprint: "reviewed" }, observe) },
    { kind: "undo", path: "/api/pulse/receipts/receipt/undo", body: {}, send: (observe: (status: unknown) => void) => pulseApi.undo("receipt", observe) },
    { kind: "group_delete", path: "/api/pulse/receipts/receipt/delete-group", body: { groupId: "group" }, send: (observe: (status: unknown) => void) => pulseApi.deletePublicationGroup("receipt", "group", observe) },
  ] as const;
  for (const request of requests) {
    const sent: Array<{ path: string; method: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), "https://app.example.test");
      sent.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.pathname.startsWith("/api/pulse/jobs/") ? Response.json(receipt()) : Response.json(job(request.kind), { status: 202 });
    };
    const observed: unknown[] = [];
    const result = await request.send((status) => observed.push(status));
    assert.equal(result.id, "receipt", request.kind);
    assert.deepEqual(sent, [
      { path: request.path, method: "POST", body: request.body },
      { path: `/api/pulse/jobs/${request.kind}-job`, method: "GET", body: undefined },
    ], request.kind);
    assert.deepEqual(observed, [job(request.kind).job], request.kind);
  }
});

test("publication job failures keep their status and code", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ code: "publication_busy", message: "Wait for the current operation to finish." }, { status: 409 }));
  for (const request of [() => pulseApi.undo("receipt"), () => pulseApi.deletePublicationGroup("receipt", "group"), () => pulseApi.publish("draft", { commandId: "receipt", expectedRevision: 1, previewFingerprint: "reviewed" })])
    await assert.rejects(request(), (error) => {
      assert.ok(error instanceof PulseApiError); assert.equal(error.status, 409); assert.equal(error.code, "publication_busy"); return true;
    });
});
