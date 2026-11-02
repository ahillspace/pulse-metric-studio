import assert from "node:assert/strict";
import test from "node:test";
import { pulseRequest, PulseApiError } from "./client";
import { pulseDimensionalForkApi } from "../dimensional-fork-api";
import { registryApi } from "./registry";
import { useConnection } from "../connections/controller";
import { deferred, draft, inventory, session } from "../testing/fixtures";
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
