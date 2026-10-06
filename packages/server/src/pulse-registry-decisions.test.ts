import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSession, setSession } from "@pulse-metric-studio/core";
import { registerPulseRoutes } from "@pulse-metric-studio/pulse";
import { buildApp } from "./app.js";

test("real subscription response redacts credential-shaped provider header diagnostics", async () => {
  const original = globalThis.fetch;
  const session = {
    serverUrl: "https://tableau.test",
    siteId: "site",
    siteContentUrl: "site",
    userId: "user",
    token: "test-only",
    apiVersion: "3.27",
  };
  setSession(session, { connectionId: "connection", patSecret: "" });
  globalThis.fetch = async (_url, init) =>
    init?.method === "POST"
      ? Response.json(
          {},
          {
            status: 400,
            headers: {
              validation_code: "400706",
              tableau_service_name: "Authorization: Basic private-test-token",
            },
          },
        )
      : Response.json({ subscriptions: [] });
  const server = buildApp({ registerPulseRoutes });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/follow",
      payload: {
        context: {
          connectionId: "connection",
          serverUrl: session.serverUrl,
          siteId: "site",
          datasourceLuid: "ds",
        },
        operations: [
          { metricId: "metric", target: { kind: "USER", id: "user" } },
        ],
      },
    });
    assert.equal(response.json().results[0].status, "failed");
    assert.equal(response.body.includes("private-test-token"), false);
    assert.match(response.json().results[0].error, /redacted/);
  } finally {
    await server.close();
    globalThis.fetch = original;
    clearSession();
  }
});

test("real follow API retains confirmed pairs when authentication stops the next provider request", async () => {
  const original = globalThis.fetch;
  const session = {
    serverUrl: "https://tableau.test",
    siteId: "site",
    siteContentUrl: "site",
    userId: "user",
    token: "test-only",
    apiVersion: "3.27",
  };
  setSession(session, { connectionId: "connection", patSecret: "" });
  let creates = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      creates++;
      return creates === 1
        ? Response.json({})
        : Response.json({ error: { code: "401001" } }, { status: 401 });
    }
    return Response.json({ subscriptions: [] });
  };
  const server = buildApp({ registerPulseRoutes });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/follow",
      payload: {
        context: {
          connectionId: "connection",
          serverUrl: session.serverUrl,
          siteId: "site",
          datasourceLuid: "ds",
        },
        operations: ["a", "b", "c"].map((metricId) => ({
          metricId,
          target: { kind: "USER", id: "user" },
        })),
      },
    });
    const body = response.json();
    assert.equal(body.results?.[0]?.status, "followed", response.body);
    assert.equal(body.results[1].status, "failed");
    assert.equal(body.results[2].status, "not_attempted");
    assert.equal(body.terminated, true);
    assert.equal(creates, 2);
  } finally {
    await server.close();
    globalThis.fetch = original;
    clearSession();
  }
});

test("real deletion review retains every cascade name and follower count before mixed bulk execution", async () => {
  const session = {
    serverUrl: "https://tableau.test",
    siteId: "site",
    siteContentUrl: "site",
    userId: "user",
    token: "test-only",
    apiVersion: "3.27",
  };
  const context = {
    connectionId: "connection",
    serverUrl: session.serverUrl,
    siteId: "site",
    datasourceLuid: "ds",
  };
  setSession(session, { connectionId: "connection", patSecret: "" });
  const metric = (id: string, isDefault: boolean) => ({
    metricId: id,
    name: `Metric ${id}`,
    measurementPeriod: {},
    timeframeLabel: "Custom",
    filters: [],
    comparison: {},
    isDefault,
    isScoped: !isDefault,
    scopedState: isDefault ? ("default" as const) : ("variant" as const),
    specification: {},
  });
  const definitions = ["a", "b", "c"].map((id) => ({
    definitionId: id,
    name: `Definition ${id}`,
    description: "",
    measure: "Sales",
    aggregation: "SUM",
    timeDimension: "Date",
    inventoryStatus: "complete" as const,
    metrics: [metric(`${id}-default`, true), metric(`${id}-variant`, false)],
  }));
  let changed = false;
  const executions: unknown[] = [];
  const server = buildApp({
    registerPulseRoutes: (app) =>
      registerPulseRoutes(app, {
        deletion: {
          inventory: async () => ({
            totalScanned: 3,
            truncated: false,
            failures: [],
            definitions: changed
              ? definitions.map((definition) =>
                  definition.definitionId === "a"
                    ? {
                        ...definition,
                        metrics: [
                          ...definition.metrics,
                          metric("later", false),
                        ],
                      }
                    : definition,
                )
              : definitions,
          }),
          followerCounts: async (_session, ids) => ({
            countsByMetricId: Object.fromEntries(ids.map((id) => [id, 7])),
            errorsByMetricId: {},
          }),
          execute: async (_session, entries) => {
            executions.push(entries);
            return {
              definitionsDeleted: 2,
              metricsDeleted: 1,
              failures: [],
              outcomes: [],
            };
          },
        },
      }),
  });
  try {
    const selection = {
      context,
      definitionIds: ["a", "b"],
      metricIds: ["a-default", "a-variant", "c-variant"],
    };
    const preview = await server.inject({
      method: "POST",
      url: "/api/pulse/registry/delete-preview",
      payload: selection,
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const plan = preview.json();
    assert.equal(plan.targets.length, 3);
    assert.deepEqual(plan.targets[0].affectedMetrics, [
      { id: "a-default", name: "Metric a-default", followerCount: 7 },
      { id: "a-variant", name: "Metric a-variant", followerCount: 7 },
    ]);
    changed = true;
    const stale = await server.inject({
      method: "POST",
      url: "/api/pulse/registry/delete",
      payload: { ...selection, previewFingerprint: plan.previewFingerprint },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(executions.length, 0);
    changed = false;
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/registry/delete",
      payload: { ...selection, previewFingerprint: plan.previewFingerprint },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(executions[0], [
      { definitionId: "a", metricIds: [], name: "Definition a" },
      { definitionId: "b", metricIds: [], name: "Definition b" },
      { metricIds: ["c-variant"], name: "Metric c-variant" },
    ]);
  } finally {
    await server.close();
    clearSession();
  }
});

test("real follow API preserves uncertainty and stops later pairs after a lost provider response", async () => {
  const original = globalThis.fetch;
  const session = {
    serverUrl: "https://tableau.test",
    siteId: "site",
    siteContentUrl: "site",
    userId: "user",
    token: "test-only",
    apiVersion: "3.27",
  };
  setSession(session, { connectionId: "connection", patSecret: "" });
  let creates = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      creates++;
      throw new Error("Connection reset after write");
    }
    return Response.json({ subscriptions: [] });
  };
  const server = buildApp({ registerPulseRoutes });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/follow",
      payload: {
        context: {
          connectionId: "connection",
          serverUrl: session.serverUrl,
          siteId: "site",
          datasourceLuid: "ds",
        },
        operations: ["a", "b"].map((metricId) => ({
          metricId,
          target: { kind: "USER", id: "user" },
        })),
      },
    });
    assert.deepEqual(
      response.json().results.map((item: any) => item.status),
      ["unknown", "not_attempted"],
    );
    assert.equal(response.json().stopped, true);
    assert.equal(response.json().terminated, false);
    assert.equal(creates, 1);
  } finally {
    await server.close();
    globalThis.fetch = original;
    clearSession();
  }
});

test("real unfollow API keeps prior successes and never sends later pairs after authentication failure", async () => {
  const original = globalThis.fetch;
  const session = {
    serverUrl: "https://tableau.test",
    siteId: "site",
    siteContentUrl: "site",
    userId: "user",
    token: "test-only",
    apiVersion: "3.27",
  };
  setSession(session, { connectionId: "connection", patSecret: "" });
  let deletes = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "DELETE")
      return ++deletes === 1
        ? new Response(null, { status: 204 })
        : Response.json({ error: { code: "401001" } }, { status: 401 });
    const metric = new URL(String(url)).searchParams.get("metric_id");
    return Response.json({
      subscriptions: [
        { id: `subscription-${metric}`, follower: { user_id: "user" } },
      ],
    });
  };
  const server = buildApp({ registerPulseRoutes });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/unfollow",
      payload: {
        context: {
          connectionId: "connection",
          serverUrl: session.serverUrl,
          siteId: "site",
          datasourceLuid: "ds",
        },
        operations: ["a", "b", "c"].map((metricId) => ({
          metricId,
          target: { kind: "USER", id: "user" },
        })),
      },
    });
    assert.deepEqual(
      response.json().results.map((item: any) => item.status),
      ["unfollowed", "failed", "not_attempted"],
    );
    assert.equal(response.json().terminated, true);
    assert.equal(deletes, 2);
  } finally {
    await server.close();
    globalThis.fetch = original;
    clearSession();
  }
});

test("follow-state uses Tableau's GET follower-count contract and reports confirmed zero", async () => {
  const original=globalThis.fetch;
  const session={serverUrl:"https://tableau.test",siteId:"site",siteContentUrl:"site",userId:"user",token:"test-only",apiVersion:"3.27"};
  setSession(session,{connectionId:"connection",patSecret:""});
  let method="";
  globalThis.fetch=async (url,init)=>{
    const parsed=new URL(String(url));
    if(parsed.pathname.endsWith('subscriptions:batchGetMetricFollowerCounts')) {
      method=init?.method||'GET';
      if(method!=='GET'||parsed.searchParams.get('metric_ids')!=='metric-a,metric-b')return Response.json({}, {status:405});
      return Response.json({follower_counts:[{metric_id:'metric-a',follower_count:0},{metric_id:'metric-b',follower_count:3}]});
    }
    if(parsed.pathname.endsWith('/subscriptions'))return Response.json({subscriptions:[]});
    return Response.json({groups:{group:[]}});
  };
  const server=buildApp({registerPulseRoutes});
  try {
    const response=await server.inject({method:'POST',url:'/api/pulse/follow-state',payload:{metricIds:['metric-a','metric-b']}});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(method,'GET');
    assert.deepEqual(response.json().followerCountsByMetricId,{'metric-a':0,'metric-b':3});
    assert.equal(response.json().availabilityByMetricId['metric-a'].followerCountStatus,'available');
  } finally {await server.close();globalThis.fetch=original;clearSession();}
});
