import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeDb,
  getDb,
  config,
  clearSession,
  setSession,
  TableauError,
  type TableauSession,
} from "@pulse-metric-studio/core";
import {
  defaultPulseMetric,
  emptyPulseDocument,
  type DatasourceCatalog,
  type PulseDraftRecord,
  type PulsePublishReceipt,
} from "@pulse-metric-studio/shared";
import { registerPulseRoutes } from "@pulse-metric-studio/pulse";
import { buildApp } from "./app.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-workflows-"));
config.dataDir = directory;
config.dbPath = path.join(directory, "test.db");
const originalFetch = globalThis.fetch;
const session: TableauSession = {
  serverUrl: "https://tableau.test",
  siteContentUrl: "site",
  siteId: "site",
  userId: "user",
  token: "test-only",
  apiVersion: "3.27",
};
const context = {
  connectionId: "connection",
  serverUrl: session.serverUrl,
  siteId: session.siteId,
  datasourceLuid: "ds",
};
const field = (id: string, role: "MEASURE" | "TIME"): any => ({
  id,
  name: id,
  label: id,
  caption: id,
  dataType: role === "TIME" ? "DATE" : "REAL",
  role,
  table: "Orders",
  defaultAggregation: null,
  formula: null,
  requiresUserAgg: false,
});
const catalog: DatasourceCatalog = {
  datasourceLuid: "ds",
  datasourceName: "Orders",
  measures: [field("Sales", "MEASURE")],
  dimensions: [
    { ...field("Region", "MEASURE"), dataType: "STRING", role: "DIMENSION" },
  ],
  timeDimensions: [field("Date", "TIME")],
  excluded: [],
  parameters: [],
  source: "vds",
  warnings: [],
};
beforeEach(() => {
  globalThis.fetch = originalFetch;
  setSession(session, {
    connectionId: context.connectionId,
    patSecret: "test",
  });
});
after(() => {
  globalThis.fetch = originalFetch;
  clearSession();
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});
function app(deps: Parameters<typeof registerPulseRoutes>[1] = {}) {
  return buildApp({
    registerPulseRoutes: (server) =>
      registerPulseRoutes(server, { catalog: async () => catalog, ...deps }),
  });
}
async function draft(server: ReturnType<typeof app>, follow = false) {
  const document = emptyPulseDocument();
  document.metrics.Sales = defaultPulseMetric(catalog, "Sales")!;
  document.groupFollow = follow;
  document.slicers.Region = {
    active: true,
    fieldId: "Region",
    fieldLabel: "Region",
  };
  // Each test gets its own datasource identity while retaining the controlled catalog.
  const created = await server.inject({
    method: "POST",
    url: "/api/pulse/drafts",
    payload: { context, datasourceName: "Orders" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const current = created.json<PulseDraftRecord>();
  const saved = await server.inject({
    method: "PUT",
    url: `/api/pulse/drafts/${current.id}`,
    payload: { expectedRevision: current.revision, document },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved.json<PulseDraftRecord>();
}
async function reviewed(
  server: ReturnType<typeof app>,
  current: PulseDraftRecord,
) {
  const preview = await server.inject({
    method: "POST",
    url: `/api/pulse/drafts/${current.id}/publish-preview`,
    payload: { expectedRevision: current.revision },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  return {
    commandId: crypto.randomUUID(),
    expectedRevision: current.revision,
    previewFingerprint: preview.json().previewFingerprint,
  };
}

test("proposal route accepts unsaved transcript and configuration without overwriting the saved draft", async () => {
  let input: any;
  const server = app({
    propose: async (value) => {
      input = value;
      return { ops: [], assistantMessage: "Reviewed transcript" };
    },
  });
  try {
    const current = await draft(server);
    const document = structuredClone(current.document);
    document.metrics.Sales!.name = "Unsaved manual name";
    const message = "Meeting transcript ".repeat(25000);
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/proposals`,
      payload: { baseRevision: current.revision, document, message },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(input.document.metrics.Sales.name, "Unsaved manual name");
    assert.equal(input.message, message.trim());
    const saved = (
      await server.inject({
        method: "GET",
        url: `/api/pulse/drafts/${current.id}`,
      })
    ).json();
    assert.equal(
      saved.document.metrics.Sales.name,
      current.document.metrics.Sales!.name,
    );
  } finally {
    await server.close();
  }
});

test("publication preview rejects zero slicers before any Tableau creation", async () => {
  let creations = 0;
  const server = app({
    publish: {
      create: async () => {
        creations++;
        return { definitionId: "unexpected", raw: {} };
      },
    },
  });
  try {
    let current = await draft(server);
    current.document.slicers = {};
    current = (
      await server.inject({
        method: "PUT",
        url: `/api/pulse/drafts/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          document: current.document,
        },
      })
    ).json();
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish-preview`,
      payload: { expectedRevision: current.revision },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(
      response
        .json()
        .issues.some((issue: any) =>
          /at least one.*(?:slicer|dimension)/i.test(issue.message),
        ),
    );
    const publication = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: {
        commandId: crypto.randomUUID(),
        expectedRevision: current.revision,
        previewFingerprint: response.json().previewFingerprint,
      },
    });
    assert.equal(publication.statusCode, 422, publication.body);
    assert.equal(creations, 0);
  } finally {
    await server.close();
  }
});

test("publication rejects an invalid slicer even when a valid dimension is also selected", async () => {
  const server = app();
  try {
    let current = await draft(server);
    current.document.slicers.Sales = {
      fieldId: "Sales",
      fieldLabel: "Sales",
      active: true,
    };
    current = (
      await server.inject({
        method: "PUT",
        url: `/api/pulse/drafts/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          document: current.document,
        },
      })
    ).json();
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish-preview`,
      payload: { expectedRevision: current.revision },
    });
    assert.ok(
      response
        .json()
        .issues.some((issue: { field: string }) => issue.field === "Sales"),
    );
  } finally {
    await server.close();
  }
});

test("new publication commands recreate deleted definitions and resolve missing user identity for group follow", async () => {
  let creations = 0;
  let resolvedUsers = 0;
  const members: string[] = [];
  const names: string[] = [];
  const server = app({
    publish: {
      create: async () => ({
        definitionId: `definition-${++creations}`,
        raw: {},
      }),
      resolve: async () => `metric-${creations}`,
      ensureGroup: async (_session, name) => {
        names.push(name);
        return { id: "group", name, existedBefore: true };
      },
      currentUser: async () => {
        resolvedUsers++;
        return "resolved-user";
      },
      addMember: async (_session, _group, user) => {
        members.push(user);
      },
      subscribe: async (_session, requests) =>
        requests.map(({ metricId, groupId }) => ({
          metricId,
          targetId: groupId,
          ok: true,
          alreadyExists: false,
        })),
      deleteDefinition: async () => {},
    },
  });
  try {
    let current = await draft(server, true);
    current.document.digestAudience = "  Sales / Leadership!!!  ";
    current = (
      await server.inject({
        method: "PUT",
        url: `/api/pulse/drafts/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          document: current.document,
        },
      })
    ).json();
    setSession(
      { ...session, userId: "" },
      { connectionId: context.connectionId, patSecret: "test" },
    );
    const request = await reviewed(server, current);
    const publish = (payload: typeof request) =>
      server.inject({
        method: "POST",
        url: `/api/pulse/drafts/${current.id}/publish`,
        payload,
      });
    const published = await publish(request);
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().digestAudience, current.document.digestAudience);
    assert.equal(published.json().siteContentUrl, session.siteContentUrl);
    const duplicate = await publish(request);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().digestAudience, current.document.digestAudience);
    assert.equal(duplicate.json().siteContentUrl, session.siteContentUrl);
    assert.equal(creations, 1);
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: `/api/pulse/receipts/${request.commandId}/undo`,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await publish({ ...request, commandId: crypto.randomUUID() }))
        .statusCode,
      200,
    );
    assert.equal(creations, 2);
    assert.equal(resolvedUsers, 2);
    assert.deepEqual(members, ["resolved-user", "resolved-user"]);
    assert.equal(names.length, 2);
    assert.equal(names[0], "pmStudio - Orders -   Sales / Leadership!!!  ");
    assert.equal(names[0], names[1]);
    assert.equal(emptyPulseDocument().groupFollow, true);
  } finally {
    await server.close();
  }
});

test("draft-list owner filtering restores older work beyond other connections first page", async () => {
  const server = app();
  try {
    const wanted = await draft(server);
    for (let index = 0; index < 12; index++) {
      await server.inject({
        method: "POST",
        url: "/api/pulse/drafts",
        payload: {
          context: { ...context, connectionId: `other-${index}` },
          datasourceName: `Other ${index}`,
        },
      });
    }
    getDb()
      .prepare("UPDATE pulse_workspaces SET updated_at=1 WHERE id=?")
      .run(wanted.id);
    const query = new URLSearchParams({
      limit: "10",
      connectionId: context.connectionId,
      serverUrl: context.serverUrl,
      siteId: context.siteId,
    });
    const result = await server.inject({
      method: "GET",
      url: `/api/pulse/drafts?${query}`,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().total, 1);
    assert.equal(result.json().drafts[0].id, wanted.id);
  } finally {
    await server.close();
  }
});

test("real draft routes save offline, reject stale edits, and keep original context", async () => {
  const server = app();
  try {
    const current = await draft(server);
    clearSession();
    const changed = { ...current.document, digestAudience: "Operations" };
    assert.equal(
      (
        await server.inject({
          method: "PUT",
          url: `/api/pulse/drafts/${current.id}`,
          payload: { expectedRevision: current.revision, document: changed },
        })
      ).statusCode,
      200,
    );
    const stale = await server.inject({
      method: "PUT",
      url: `/api/pulse/drafts/${current.id}`,
      payload: {
        expectedRevision: current.revision,
        document: current.document,
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "draft_revision_conflict");
    const read = (
      await server.inject(`/api/pulse/drafts/${current.id}`)
    ).json<PulseDraftRecord>();
    assert.equal(read.document.digestAudience, "Operations");
    assert.deepEqual(read.context, context);
  } finally {
    await server.close();
  }
});

test("publish preserves partial outcomes, ignores duplicate commands, and supports offline receipts and attributable undo", async () => {
  let creates = 0;
  const deleted: string[] = [];
  const server = app({
    publish: {
      create: async () => {
        creates++;
        return { definitionId: "confirmed-definition", raw: {} };
      },
      resolve: async () => {
        throw new Error("Delayed metric");
      },
      deleteDefinition: async (_session, id) => {
        deleted.push(id);
      },
    },
  });
  try {
    const current = await draft(server);
    const request = await reviewed(server, current);
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(response.statusCode, 200, response.body);
    const receipt = response.json<PulsePublishReceipt>();
    assert.equal(receipt.items[0]?.creationStatus, "created");
    assert.equal(receipt.items[0]?.resolutionStatus, "failed");
    assert.equal(receipt.items[0]?.definitionId, "confirmed-definition");
    clearSession();
    assert.equal(
      (await server.inject(`/api/pulse/receipts/${receipt.id}`)).statusCode,
      200,
    );
    const repeated = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(creates, 1);
    const conflict = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: { ...request, expectedRevision: 999 },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: `/api/pulse/receipts/${receipt.id}/undo`,
        })
      ).statusCode,
      401,
    );
    setSession(session, {
      connectionId: context.connectionId,
      patSecret: "test",
    });
    const undone = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${receipt.id}/undo`,
    });
    assert.equal(undone.statusCode, 200, undone.body);
    assert.equal(
      undone.json<PulsePublishReceipt>().items[0]?.undoStatus,
      "deleted",
    );
    assert.match(
      undone.json<PulsePublishReceipt>().items[0]?.diagnostic?.message ?? "",
      /Delayed/,
    );
    await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${receipt.id}/undo`,
    });
    assert.deepEqual(deleted, ["confirmed-definition"]);
  } finally {
    await server.close();
  }
});

test("lost creation response remains unknown after restart and does not replay", async () => {
  let creates = 0;
  let server = app({
    publish: {
      create: async () => {
        creates++;
        throw new TableauError("Response lost", 0, "", "network");
      },
    },
  });
  try {
    const current = await draft(server);
    const request = await reviewed(server, current);
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(
      response.json<PulsePublishReceipt>().items[0]?.creationStatus,
      "unknown",
    );
    await server.close();
    closeDb();
    clearSession();
    server = app();
    const receipt = (
      await server.inject(`/api/pulse/receipts/${request.commandId}`)
    ).json<PulsePublishReceipt>();
    assert.equal(receipt.items[0]?.creationStatus, "unknown");
    assert.equal(receipt.undoEligible, false);
    assert.equal(creates, 1);
  } finally {
    await server.close();
  }
});

test("proposal returns a locked candidate without modifying the saved draft", async () => {
  const server = app({
    propose: async () => ({
      assistantMessage: "Proposed change",
      ops: [
        {
          op: "MODIFY_METRIC",
          fieldId: "Sales",
          name: "Overwritten",
          description: "Proposed description",
        },
      ],
    }),
  });
  try {
    let current = await draft(server);
    current.document.metrics.Sales!.locks = ["name"];
    current = (
      await server.inject({
        method: "PUT",
        url: `/api/pulse/drafts/${current.id}`,
        payload: {
          expectedRevision: current.revision,
          document: current.document,
        },
      })
    ).json();
    const proposal = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/proposals`,
      payload: { baseRevision: current.revision, message: "Improve it" },
    });
    assert.equal(proposal.statusCode, 200, proposal.body);
    assert.equal(
      proposal.json().candidateDocument.metrics.Sales.name,
      current.document.metrics.Sales!.name,
    );
    assert.equal(
      proposal.json().candidateDocument.metrics.Sales.description,
      "Proposed description",
    );
    assert.deepEqual(
      (await server.inject(`/api/pulse/drafts/${current.id}`)).json(),
      current,
    );
  } finally {
    await server.close();
  }
});

test("stale group creation is rejected through the real publish route before any write", async () => {
  let groupWrites = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "GET" && url.endsWith("/api/-/groups"))
      return Response.json({ groups: [] });
    if (init?.method === "GET" && url.includes("/groups?")) {
      setSession(
        { ...session, siteId: "other" },
        { connectionId: "other", patSecret: "test" },
      );
      return Response.json({ groups: { group: [] } });
    }
    if (init?.method === "POST" && url.endsWith("/groups")) {
      groupWrites++;
      return new Response('<tsResponse><group id="new-group" /></tsResponse>');
    }
    throw new Error(`Unexpected provider request ${url}`);
  };
  const server = app({
    publish: {
      create: async () => ({ definitionId: "group-definition", raw: {} }),
      resolve: async () => "group-metric",
    },
  });
  try {
    const current = await draft(server, true);
    const request = await reviewed(server, current);
    await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(
      groupWrites,
      0,
      "A group write reached the previous Tableau session after switching connections.",
    );
  } finally {
    await server.close();
  }
});

test("unreviewed legacy deletion cannot bypass a backend plan", async () => {
  let deletes = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "DELETE") deletes++;
    return new Response(null, { status: 204 });
  };
  const server = app();
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/pulse/delete",
      payload: {
        entries: [{ definitionId: "unreviewed-definition", metricIds: [] }],
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(deletes, 0);
  } finally {
    await server.close();
  }
});

test("backend deletion rejects incomplete cascades and changed plans without deleting visible children as a definition", async () => {
  let completeness: "complete" | "partial" = "partial";
  let extra = false;
  const deletions: unknown[] = [];
  const variant = (metricId: string): any => ({
    metricId,
    name: metricId,
    measurementPeriod: {},
    timeframeLabel: "Custom",
    filters: [],
    comparison: {},
    isDefault: false,
    isScoped: true,
    scopedState: "variant",
    specification: {},
  });
  const server = app({
    deletion: {
      inventory: async () => ({
        totalScanned: 1,
        truncated: false,
        failures: [],
        definitions: [
          {
            definitionId: "definition",
            name: "Sales",
            description: "",
            measure: "Sales",
            aggregation: "SUM",
            timeDimension: "Date",
            inventoryStatus: completeness,
            metrics: [variant("metric"), ...(extra ? [variant("later")] : [])],
          },
        ],
      }),
      execute: async (_session, entries) => {
        deletions.push(...entries);
        return {
          definitionsDeleted: 0,
          metricsDeleted: entries.length,
          failures: [],
          outcomes: [],
        };
      },
    },
  });
  try {
    const selection = { context, definitionIds: ["definition"], metricIds: [] };
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/pulse/registry/delete-preview",
          payload: selection,
        })
      ).statusCode,
      409,
    );
    completeness = "complete";
    const plan = (
      await server.inject({
        method: "POST",
        url: "/api/pulse/registry/delete-preview",
        payload: selection,
      })
    ).json();
    extra = true;
    const changed = await server.inject({
      method: "POST",
      url: "/api/pulse/registry/delete",
      payload: { ...selection, previewFingerprint: plan.previewFingerprint },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().code, "delete_plan_changed");
    assert.equal(deletions.length, 0);
    const exact = { context, definitionIds: [], metricIds: ["metric"] };
    const exactPlan = (
      await server.inject({
        method: "POST",
        url: "/api/pulse/registry/delete-preview",
        payload: exact,
      })
    ).json();
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/pulse/registry/delete",
          payload: {
            ...exact,
            previewFingerprint: exactPlan.previewFingerprint,
          },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(deletions, [{ metricIds: ["metric"], name: "metric" }]);
  } finally {
    await server.close();
  }
});

test("local history pages omit large documents, preserve detail, and search literal characters", async () => {
  const server = app();
  try {
    for (let index = 0; index < 3; index++) {
      const document = emptyPulseDocument();
      document.chat = Array.from({ length: 10 }, () => ({
        role: "user" as const,
        content: "x".repeat(30_000),
        ts: 1,
      }));
      const saved = await server.inject({
        method: "POST",
        url: "/api/pulse/drafts",
        payload: {
          context: { ...context, datasourceLuid: `page-${index}` },
          datasourceName: index === 0 ? "Page %_ literal" : `Page ${index}`,
          document,
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
    }
    const first = await server.inject("/api/pulse/drafts?limit=2&q=Page");
    assert.equal(first.json().total, 3);
    assert.equal(first.json().drafts.length, 2);
    assert.ok(first.body.length < 2000);
    assert.equal(first.json().drafts[0].document, undefined);
    const next = await server.inject(
      "/api/pulse/drafts?limit=2&offset=2&q=Page",
    );
    assert.equal(next.json().drafts.length, 1);
    const literal = await server.inject("/api/pulse/drafts?q=%25_");
    assert.equal(literal.json().total, 1);
    const detail = await server.inject(
      `/api/pulse/drafts/${literal.json().drafts[0].id}`,
    );
    assert.equal(detail.json().document.chat[0].content.length, 30_000);
    assert.equal(
      (await server.inject("/api/pulse/drafts?limit=101")).statusCode,
      400,
    );
    const receipts = (
      await server.inject("/api/pulse/receipts?limit=1")
    ).json();
    assert.equal(receipts.limit, 1);
    assert.ok(receipts.total >= 1);
    assert.equal(receipts.receipts.length, 1);
    assert.equal(receipts.receipts[0].items, undefined);
    assert.equal(receipts.receipts[0].follow, undefined);
    const full = (
      await server.inject(`/api/pulse/receipts/${receipts.receipts[0].id}`)
    ).json();
    assert.equal(full.createdCount, receipts.receipts[0].createdCount);
  } finally {
    await server.close();
  }
});

test("publish stops optional writes after membership authentication expires", async () => {
  let subscriptions = 0;
  const server = app({
    publish: {
      create: async () => ({ definitionId: "auth-definition", raw: {} }),
      resolve: async () => "auth-metric",
      ensureGroup: async () => ({
        id: "auth-group",
        name: "Auth group",
        existedBefore: true,
      }),
      addMember: async () => {
        throw new TableauError("Session expired", 401, "", "auth");
      },
      subscribe: async () => {
        subscriptions++;
        return [];
      },
    },
  });
  try {
    const current = await draft(server, true);
    const request = await reviewed(server, current);
    const response = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(subscriptions, 0);
    assert.equal(
      response.json().follow.subscriptions[0].status,
      "not_attempted",
    );
  } finally {
    await server.close();
  }
});

test("failed confirmed-ID persistence stops subsequent remote effects and retains an unknown receipt", async () => {
  let resolutions = 0;
  const server = app({
    publish: {
      create: async () => ({ definitionId: "not-saved-definition", raw: {} }),
      resolve: async () => {
        resolutions++;
        return "must-not-resolve";
      },
    },
  });
  try {
    const current = await draft(server);
    const request = await reviewed(server, current);
    getDb().exec(
      "CREATE TRIGGER reject_confirmed BEFORE UPDATE ON pulse_publish_items WHEN NEW.creation_status='created' BEGIN SELECT RAISE(ABORT,'Simulated disk failure'); END",
    );
    const result = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(result.statusCode, 500);
    assert.equal(resolutions, 0);
    const receipt = (
      await server.inject(`/api/pulse/receipts/${request.commandId}`)
    ).json();
    assert.equal(receipt.items[0].creationStatus, "unknown");
    assert.equal(receipt.interrupted, true);
    assert.equal(receipt.publishing, false);
  } finally {
    getDb().exec("DROP TRIGGER IF EXISTS reject_confirmed");
    await server.close();
  }
});

test("undo retains ambiguous provider failures and confirms an already absent definition on retry", async () => {
  let attempts = 0;
  const server = app({
    publish: {
      create: async () => ({ definitionId: "undo-uncertain", raw: {} }),
      resolve: async () => "undo-metric",
      deleteDefinition: async () => {
        attempts++;
        throw new TableauError(
          attempts === 1 ? "Remote failure after deletion" : "Absent",
          attempts === 1 ? 500 : 404,
          "",
          "http",
        );
      },
    },
  });
  try {
    const current = await draft(server);
    const request = await reviewed(server, current);
    await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    const first = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/undo`,
    });
    assert.equal(first.json().items[0].undoStatus, "unknown");
    const second = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/undo`,
    });
    assert.equal(second.json().items[0].undoStatus, "deleted");
    await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/undo`,
    });
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("provider credential fields are redacted before a publication diagnostic is persisted", async () => {
  const secrets = [
    "fixture-token-value",
    "fixture-pat-value",
    "fixture-api-value",
  ];
  const server = app({
    publish: {
      create: async () => {
        throw new TableauError(
          JSON.stringify({
            token: secrets[0],
            personalAccessTokenSecret: secrets[1],
            apiKey: secrets[2],
            message: "Permission denied",
          }),
          403,
          "",
          "http",
        );
      },
    },
  });
  try {
    const current = await draft(server);
    const request = await reviewed(server, current);
    const result = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(result.statusCode, 200, result.body);
    const stored = getDb()
      .prepare("SELECT diagnostic_json FROM pulse_publish_items WHERE run_id=?")
      .pluck()
      .get(request.commandId) as string;
    for (const secret of secrets) {
      assert.equal(result.body.includes(secret), false);
      assert.equal(stored.includes(secret), false);
    }
    assert.match(stored, /Permission denied/);
  } finally {
    await server.close();
  }
});

test("publication group deletion is separate, exact, owner-bound and durable", async () => {
  const deleted: string[] = [];
  const server = app({
    publish: {
      create: async () => ({ definitionId: "group-test-definition", raw: {} }),
      resolve: async () => "group-test-metric",
      ensureGroup: async (_session, name) => ({
        id: "created-group",
        name,
        existedBefore: false,
      }),
      addMember: async () => {},
      subscribe: async (_session, items) =>
        items.map((item) => ({
          metricId: item.metricId,
          targetId: item.groupId,
          ok: true,
          alreadyExists: false,
        })),
      deleteDefinition: async () => {
        deleted.push("definition");
      },
      deleteGroup: async (_session, id) => {
        deleted.push(id);
      },
    },
  });
  try {
    const current = await draft(server, true);
    const request = await reviewed(server, current);
    const published = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(published.statusCode, 200, published.body);
    const undo = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/undo`,
      payload: {},
    });
    assert.equal(undo.statusCode, 200);
    assert.deepEqual(deleted, ["definition"]);
    const wrong = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/delete-group`,
      payload: { groupId: "other-group" },
    });
    assert.equal(wrong.statusCode, 409, wrong.body);
    clearSession();
    const disconnected = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/delete-group`,
      payload: { groupId: "created-group" },
    });
    assert.equal(disconnected.statusCode, 401);
    setSession(session, {
      connectionId: context.connectionId,
      patSecret: "test",
    });
    const result = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/delete-group`,
      payload: { groupId: "created-group" },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().follow.group.deletion.status, "deleted");
    const again = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${request.commandId}/delete-group`,
      payload: { groupId: "created-group" },
    });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(deleted, ["definition", "created-group"]);
    const read = await server.inject({
      method: "GET",
      url: `/api/pulse/receipts/${request.commandId}`,
    });
    assert.equal(read.json().follow.group.deletion.status, "deleted");
  } finally {
    await server.close();
  }
});

test("group deletion rejects reused groups and persists ambiguous failures before safe exact-ID retry", async () => {
  let reused = true,
    calls = 0;
  const server = app({
    publish: {
      create: async () => ({
        definitionId: "group-delete-definition",
        raw: {},
      }),
      resolve: async () => "group-delete-metric",
      ensureGroup: async (_session, name) => ({
        id: "group-delete-id",
        name,
        existedBefore: reused,
      }),
      addMember: async () => {},
      subscribe: async (_session, items) =>
        items.map((item) => ({
          metricId: item.metricId,
          targetId: item.groupId,
          ok: true,
          alreadyExists: false,
        })),
      deleteGroup: async () => {
        calls++;
        throw calls === 1
          ? new Error("Response lost")
          : new TableauError("Not found", 404, "", "http");
      },
    },
  });
  try {
    const current = await draft(server, true);
    const first = await reviewed(server, current);
    await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: first,
    });
    const refused = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${first.commandId}/delete-group`,
      payload: { groupId: "group-delete-id" },
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(calls, 0);
    reused = false;
    const second = await reviewed(server, current);
    await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: second,
    });
    const lost = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${second.commandId}/delete-group`,
      payload: { groupId: "group-delete-id" },
    });
    assert.equal(lost.statusCode, 200, lost.body);
    assert.equal(lost.json().follow.group.deletion.status, "unknown");
    const read = await server.inject({
      method: "GET",
      url: `/api/pulse/receipts/${second.commandId}`,
    });
    assert.equal(read.json().follow.group.deletion.status, "unknown");
    assert.equal(calls, 1);
    const retry = await server.inject({
      method: "POST",
      url: `/api/pulse/receipts/${second.commandId}/delete-group`,
      payload: { groupId: "group-delete-id" },
    });
    assert.equal(retry.json().follow.group.deletion.status, "deleted");
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("receipt cannot be cleared while its group deletion is in flight", async () => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = app({
    publish: {
      create: async () => ({ definitionId: "clear-guard-def", raw: {} }),
      resolve: async () => "clear-guard-metric",
      ensureGroup: async (_session, name) => ({
        id: "clear-guard-group",
        name,
        existedBefore: false,
      }),
      addMember: async () => {},
      subscribe: async () => [],
      deleteGroup: async () => {
        started();
        await pending;
      },
    },
  });
  try {
    const current = await draft(server, true),
      request = await reviewed(server, current);
    await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    const deletion = server
      .inject({
        method: "POST",
        url: `/api/pulse/receipts/${request.commandId}/delete-group`,
        payload: { groupId: "clear-guard-group" },
      })
      .then((result) => result);
    await entered;
    const clearing = await server.inject({
      method: "DELETE",
      url: `/api/pulse/receipts/${request.commandId}`,
    });
    assert.equal(clearing.statusCode, 409, clearing.body);
    release();
    const completed = await deletion;
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().follow.group.deletion.status, "deleted");
  } finally {
    release();
    await server.close();
  }
});

test("receipt clearing preserves every unresolved follow outcome", async () => {
  const server = app({
    publish: {
      create: async () => ({ definitionId: "uncertain-follow-def", raw: {} }),
      resolve: async () => "uncertain-follow-metric",
    },
  });
  try {
    const current = await draft(server),
      request = await reviewed(server, current);
    const publication = await server.inject({
      method: "POST",
      url: `/api/pulse/drafts/${current.id}/publish`,
      payload: request,
    });
    assert.equal(publication.statusCode, 200, publication.body);
    const original = publication.json<PulsePublishReceipt>().follow;
    const cases = [
      { ...original, group: { status: "unknown" } },
      { ...original, membership: { status: "unknown" } },
      { ...original, subscriptions: [{ itemIndex: 0, status: "unknown" }] },
      {
        ...original,
        group: {
          status: "created",
          id: "group",
          deletion: { status: "unknown" },
        },
      },
    ];
    for (const follow of cases) {
      getDb()
        .prepare(
          "UPDATE pulse_publish_runs SET follow_receipt_json=? WHERE id=?",
        )
        .run(JSON.stringify(follow), request.commandId);
      const result = await server.inject({
        method: "DELETE",
        url: `/api/pulse/receipts/${request.commandId}`,
      });
      assert.equal(result.statusCode, 409, JSON.stringify(follow));
    }
    getDb()
      .prepare("UPDATE pulse_publish_runs SET follow_receipt_json=? WHERE id=?")
      .run(JSON.stringify(original), request.commandId);
    const resolved = await server.inject({
      method: "DELETE",
      url: `/api/pulse/receipts/${request.commandId}`,
    });
    assert.equal(resolved.statusCode, 200, resolved.body);
  } finally {
    await server.close();
  }
});
