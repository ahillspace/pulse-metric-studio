import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPulseProposal,
  OpsSchema,
  type PulseAuthorProposal,
  type PulseDraftRecord,
  type PulsePublishPlan,
} from "@pulse-metric-studio/shared";
import {
  createAuthorController,
  activeEditor,
  proposalIsStale,
  previewIsStale,
} from "./controller";
import { PulseApiError } from "../api/client";
import {
  catalog,
  deferred,
  draft,
  receipt,
  session,
} from "../testing/fixtures";

function fixture(
  overrides: Record<string, unknown> = {},
  currentSession: () => typeof session | null = () => session,
  onInventoryChanged: (context: PulseDraftRecord["context"]) => void = () => {},
) {
  const records = new Map([
    ["a", draft("a")],
    ["b", draft("b")],
  ]);
  const transport = {
    listDrafts: async () => ({
      drafts: [...records.values()],
      total: records.size,
      offset: 0,
      limit: 10,
    }),
    createDraft: async (input: { context: { datasourceLuid: string } }) =>
      records.get(input.context.datasourceLuid)!,
    readDraft: async (id: string) => structuredClone(records.get(id)!),
    saveDraft: async (
      id: string,
      input: {
        expectedRevision: number;
        document: PulseDraftRecord["document"];
      },
    ) => {
      const previous = records.get(id)!;
      if (previous.revision !== input.expectedRevision)
        throw new PulseApiError(
          "Draft changed",
          409,
          "draft_revision_conflict",
        );
      const next = {
        ...previous,
        document: structuredClone(input.document),
        revision: previous.revision + 1,
      };
      records.set(id, next);
      return next;
    },
    deleteDraft: async (id: string) => {
      records.delete(id);
    },
    propose: async (
      id: string,
      baseRevision: number,
    ): Promise<PulseAuthorProposal> => ({
      baseRevision,
      candidateDocument: {
        ...records.get(id)!.document,
        digestAudience: "Suggested",
      },
      assistantMessage: "Suggested audience",
      changes: [
        { field: "digestAudience", message: "Set audience to Suggested" },
      ],
    }),
    preview: async (
      id: string,
      revision: number,
    ): Promise<PulsePublishPlan> => ({
      draftId: id,
      revision,
      context: records.get(id)!.context,
      datasourceName: id,
      previewFingerprint: "reviewed",
      metrics: [
        { ...receipt().items[0].summary, name: "Sales", description: "" },
      ],
      digestAudience: "",
      groupFollow: false,
      issues: [],
    }),
    publish: async () => receipt(),
    ...overrides,
  };
  const store = createAuthorController(
    transport,
    async (id) => ({ catalog: catalog(id) }),
    currentSession,
    () => {},
    60_000,
    onInventoryChanged,
  );
  return { store, records, transport };
}

test("assistant continues from current edits when local saving fails and preserves discarded conversation", async (t) => {
  let received: any;
  const { store } = fixture({
    saveDraft: async () => {
      throw new Error("Disk full");
    },
    propose: async (
      _id: string,
      revision: number,
      _message: string,
      document: any,
    ) => {
      received = document;
      return {
        baseRevision: revision,
        candidateDocument: { ...document, digestAudience: "Proposal" },
        assistantMessage: "Proposed audience",
        changes: [],
      };
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().updateMetric("Sales", { name: "Manual name" });
  await store.getState().requestProposal("Suggest a refinement");
  assert.equal(received?.metrics.Sales.name, "Manual name");
  assert.ok(received.metrics.Sales.locks.includes("name"));
  store.getState().discardProposal();
  assert.equal(activeEditor(store.getState())?.document.chat.length, 2);
  assert.match(
    activeEditor(store.getState())?.document.chat[1].content ?? "",
    /Proposed audience/,
  );
  assert.equal(activeEditor(store.getState())?.saveStatus, "error");
  await store.getState().requestProposal("Refine the discarded suggestion");
  assert.equal(received.chat.length, 2);
  assert.match(received.chat[1].proposalContext, /Proposal/);
});

test("clearing the assistant chat removes the conversation and pending proposal but keeps metric edits", async (t) => {
  let received: any;
  const { store } = fixture({
    propose: async (_id: string, revision: number, _message: string, document: any) => {
      received = document;
      return { baseRevision: revision, candidateDocument: { ...document, digestAudience: "Proposal" }, assistantMessage: "Proposed audience", changes: [] };
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().updateMetric("Sales", { name: "Manual name" });
  await store.getState().requestProposal("Suggest a refinement");
  store.getState().clearChat();
  const entry = activeEditor(store.getState());
  assert.equal(entry?.document.chat.length, 0);
  assert.equal(entry?.proposal, null);
  assert.equal(entry?.document.metrics.Sales.name, "Manual name");
  await store.getState().requestProposal("Start over");
  assert.equal(received.chat.length, 0);
});

test("a lost publication response refreshes its attempted datasource without clearing uncertainty", async (t) => {
  const pending = deferred<ReturnType<typeof receipt>>();
  const invalidated: PulseDraftRecord["context"][] = [];
  const { store } = fixture({ publish: () => pending.promise }, () => session, (context) => invalidated.push(context));
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().reviewPublication();
  const publishing = store.getState().publishReviewed();
  await store.getState().openDraft("b");
  pending.reject(new Error("Response lost"));
  await publishing;
  assert.deepEqual(invalidated, [draft("a").context]);
  assert.ok(store.getState().entries.a.publishCommandId);
  assert.match(store.getState().entries.a.publishError ?? "", /unconfirmed/);
  assert.equal(store.getState().entries.a.receipt, null);
});

test("publication invalidates once after a receipt, but not when no request was sent", async (t) => {
  let connected: typeof session | null = session;
  const invalidated: PulseDraftRecord["context"][] = [];
  const { store } = fixture({}, () => connected, (context) => invalidated.push(context));
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().reviewPublication();
  await store.getState().publishReviewed();
  assert.deepEqual(invalidated, [draft("a").context]);
  await store.getState().reviewPublication();
  connected = null;
  await store.getState().publishReviewed();
  assert.equal(invalidated.length, 1);
});

test("startup restoration scopes its first page to the active connection owner", async (t) => {
  let requested: Record<string, unknown> = {};
  const { store } = fixture({
    listDrafts: async (query: Record<string, unknown>) => {
      requested = query;
      return { drafts: [draft("a")], total: 1, offset: 0, limit: 10 };
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().loadDrafts();
  assert.equal(requested.connectionId, session.connectionId);
  assert.equal(requested.serverUrl, session.serverUrl);
  assert.equal(requested.siteId, session.siteId);
  assert.equal(activeEditor(store.getState())?.record.id, "a");
});

test("local drafts open, edit, save, and preserve conversation timestamps without authentication", async (t) => {
  const { store, records } = fixture({}, () => null);
  t.after(() => store.getState().dispose());
  records.get("a")!.document.chat = [
    { role: "user", content: "Original", ts: 42 },
  ];
  await store.getState().loadDrafts();
  await store.getState().openDraft("a");
  store.getState().setAudience("Offline audience");
  await store.getState().flush();
  assert.equal(records.get("a")?.document.digestAudience, "Offline audience");
  assert.equal(records.get("a")?.document.chat[0].ts, 42);
  assert.equal(activeEditor(store.getState())?.saveStatus, "saved");
});

test("a save acknowledgment preserves newer edits and serializes the next revision", async (t) => {
  const first = deferred<PulseDraftRecord>();
  const writes: Array<{
    expectedRevision: number;
    document: PulseDraftRecord["document"];
  }> = [];
  const { store } = fixture({
    saveDraft: async (_id: string, input: (typeof writes)[number]) => {
      writes.push(input);
      return writes.length === 1
        ? first.promise
        : { ...draft(), revision: 3, document: input.document };
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().setAudience("First");
  const saving = store.getState().flush();
  store.getState().setAudience("Second");
  first.resolve({ ...draft(), revision: 2, document: writes[0].document });
  await saving;
  assert.deepEqual(
    writes.map((input) => [
      input.expectedRevision,
      input.document.digestAudience,
    ]),
    [
      [1, "First"],
      [2, "Second"],
    ],
  );
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "Second",
  );
});

test("queued saves retain their owner after navigation and do not overwrite another draft", async (t) => {
  const { store, records } = fixture();
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().setAudience("A audience");
  await store.getState().openDraft("b");
  store.getState().setAudience("B audience");
  await Promise.all([store.getState().flush("a"), store.getState().flush("b")]);
  assert.equal(records.get("a")?.document.digestAudience, "A audience");
  assert.equal(records.get("b")?.document.digestAudience, "B audience");
  assert.equal(store.getState().activeId, "b");
});

test("failed saves retain the buffer and can retry; conflicts require review", async (t) => {
  const { store, records, transport } = fixture();
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  let failure = true;
  const original = transport.saveDraft;
  transport.saveDraft = async (...args) => {
    if (failure) throw new Error("Disk unavailable");
    return original(...args);
  };
  store.getState().setAudience("Keep this");
  await assert.rejects(store.getState().flush(), /Disk unavailable/);
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "Keep this",
  );
  failure = false;
  await store.getState().flush();
  records.set("a", {
    ...records.get("a")!,
    revision: records.get("a")!.revision + 1,
  });
  store.getState().setAudience("Local conflict");
  await assert.rejects(store.getState().flush(), /Draft changed/);
  assert.equal(activeEditor(store.getState())?.saveStatus, "conflict");
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "Local conflict",
  );
});

test("an older draft load cannot replace a newer navigation selection", async (t) => {
  const pending = deferred<PulseDraftRecord>();
  const { store } = fixture({
    readDraft: (id: string) =>
      id === "a" ? pending.promise : Promise.resolve(draft(id)),
  });
  t.after(() => store.getState().dispose());
  const a = store.getState().openDraft("a");
  await store.getState().openDraft("b");
  pending.resolve(draft("a"));
  await a;
  assert.equal(store.getState().activeId, "b");
});

test("assistant suggestions are not applied until accepted and saved", async (t) => {
  const { store, records } = fixture();
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().requestProposal("Suggest an audience");
  assert.equal(activeEditor(store.getState())?.document.digestAudience, "");
  assert.equal(records.get("a")?.document.chat.length, 2);
  const beforeAccept = records.get("a")!.revision;
  await store.getState().acceptProposal();
  assert.equal(records.get("a")?.document.digestAudience, "Suggested");
  assert.equal(records.get("a")?.revision, beforeAccept + 1);
});

test("manual edits after proposal start preserve current values without invalidating the candidate", async (t) => {
  const pending = deferred<PulseAuthorProposal>();
  const { store } = fixture({ propose: () => pending.promise });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  const proposing = store.getState().requestProposal("Suggest");
  await Promise.resolve();
  store.getState().setAudience("Manual");
  pending.resolve({
    baseRevision: 1,
    candidateDocument: { ...draft().document, digestAudience: "Stale" },
    assistantMessage: "Stale",
    changes: [],
  });
  await proposing;
  assert.equal(proposalIsStale(activeEditor(store.getState())!), false);
  await store.getState().acceptProposal();
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "Manual",
  );
});

test("clear while a proposal is pending cannot restore removed metrics", async (t) => {
  const pending = deferred<PulseAuthorProposal>();
  const { store } = fixture({ propose: () => pending.promise });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  const proposing = store.getState().requestProposal("Suggest");
  await Promise.resolve();
  store.getState().clearConfiguration();
  const candidate = draft().document;
  candidate.metrics.New = {
    ...candidate.metrics.Sales!,
    fieldId: "New",
    fieldLabel: "New",
  };
  pending.resolve({
    baseRevision: 1,
    candidateDocument: candidate,
    assistantMessage: "Older suggestion",
    changes: [],
  });
  await proposing;
  await store.getState().acceptProposal();
  assert.deepEqual(activeEditor(store.getState())?.document.metrics, {});
});

test('a submitted message clears whitespace-normalized composer text', async (t) => {
  const { store } = fixture();
  t.after(() => store.getState().dispose());
  await store.getState().openDraft('a');
  store.getState().setComposer('  Suggest an audience  ');
  await store.getState().requestProposal('Suggest an audience');
  assert.equal(activeEditor(store.getState())?.composer, '');
});

test('a failed assistant submission preserves the full composer text for retry', async (t) => {
  const { store } = fixture({ propose: async () => { throw new Error('Provider unavailable'); } });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft('a');
  const message = '  Add customer count and Region\nKeep existing metrics.  ';
  store.getState().setComposer(message);
  await store.getState().requestProposal(message.trim());
  assert.equal(activeEditor(store.getState())?.composer, message);
  assert.equal(activeEditor(store.getState())?.proposalBusy, false);
  assert.match(activeEditor(store.getState())?.proposalError ?? '', /Provider unavailable/);
});

test("a late assistant response preserves the next message being composed", async (t) => {
  const pending = deferred<PulseAuthorProposal>();
  const { store } = fixture({ propose: () => pending.promise });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().setComposer("First request");
  const proposing = store.getState().requestProposal("First request");
  store.getState().setComposer("Next request still being written");
  pending.resolve({
    baseRevision: 1,
    candidateDocument: draft().document,
    assistantMessage: "Suggestion",
    changes: [],
  });
  await proposing;
  assert.equal(
    activeEditor(store.getState())?.composer,
    "Next request still being written",
  );
});

test("late proposal success and failure stay attached to their originating draft", async (t) => {
  const a = deferred<PulseAuthorProposal>();
  const b = deferred<PulseAuthorProposal>();
  const { store } = fixture({
    propose: (id: string) => (id === "a" ? a.promise : b.promise),
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  const pa = store.getState().requestProposal("A");
  await store.getState().openDraft("b");
  const pb = store.getState().requestProposal("B");
  a.reject(new Error("A failed"));
  await pa;
  assert.equal(activeEditor(store.getState())?.proposalBusy, true);
  assert.equal(activeEditor(store.getState())?.proposalError, null);
  b.resolve({
    baseRevision: 1,
    candidateDocument: draft("b").document,
    assistantMessage: "B",
    changes: [],
  });
  await pb;
  assert.equal(activeEditor(store.getState())?.proposal?.assistantMessage, "B");
});

test("failed initial proposal remains retryable", async (t) => {
  let fail = true;
  const { store } = fixture({
    propose: async () => {
      if (fail) throw new Error("Provider unavailable");
      return {
        baseRevision: 1,
        candidateDocument: draft().document,
        assistantMessage: "Ready",
        changes: [],
      };
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().requestProposal("Generate");
  assert.equal(activeEditor(store.getState())?.proposalBusy, false);
  fail = false;
  await store.getState().requestProposal("Generate");
  assert.equal(
    activeEditor(store.getState())?.proposal?.assistantMessage,
    "Ready",
  );
});

test("saved revision is reviewed and local edits invalidate publication", async (t) => {
  let published = 0;
  const { store } = fixture({
    publish: async () => {
      published++;
      return receipt();
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  store.getState().setAudience("Reviewed");
  await store.getState().reviewPublication();
  assert.equal(activeEditor(store.getState())?.preview?.revision, 2);
  store.getState().setAudience("Newer");
  assert.equal(previewIsStale(activeEditor(store.getState())!), true);
  await store.getState().publishReviewed();
  assert.equal(published, 0);
});

test("uncertain HTTP publication reuses the command ID when explicitly checked again", async (t) => {
  const commands: string[] = [];
  const { store } = fixture({
    publish: async (_id: string, input: { commandId: string }) => {
      commands.push(input.commandId);
      if (commands.length === 1) throw new Error("Response lost");
      return receipt();
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().reviewPublication();
  await store.getState().publishReviewed();
  assert.match(
    activeEditor(store.getState())?.publishError ?? "",
    /unconfirmed/,
  );
  await store.getState().publishReviewed();
  assert.equal(commands.length, 2);
  assert.equal(commands[0], commands[1]);
  assert.equal(activeEditor(store.getState())?.receipt?.id, "receipt");
});

for (const granularity of ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]) {
  for (const alias of [granularity, `GRANULARITY_BY_${granularity}`]) {
    test(`reviewed candidate preserves ${alias} through domain application and save`, async (t) => {
      const candidate = applyPulseProposal(
        draft().document,
        [
          OpsSchema.parse({
            op: "MODIFY_METRIC",
            fieldId: "Sales",
            minGranularity: alias,
          }),
        ],
        catalog(),
      );
      const { store, records } = fixture({
        propose: async () => ({
          baseRevision: 1,
          candidateDocument: candidate,
          changes: [],
          assistantMessage: "Granularity",
        }),
      });
      t.after(() => store.getState().dispose());
      await store.getState().openDraft("a");
      await store.getState().requestProposal("Change granularity");
      await store.getState().acceptProposal();
      assert.equal(
        records.get("a")?.document.metrics.Sales.minGranularity,
        granularity,
      );
    });
  }
}

test("explicit manual locks, cumulative rules, and date choices survive reviewed operations", () => {
  const document = draft().document;
  document.metrics.Sales.timeDimensionFieldId = "Ship Date";
  document.metrics.Sales.temporality = "LATEST";
  document.metrics.Sales.locks = ["timeDimensionFieldId"];
  for (const operation of ["ADD_METRIC", "MODIFY_METRIC"] as const) {
    const next = applyPulseProposal(
      document,
      [
        {
          op: operation,
          fieldId: "Sales",
          timeDimensionFieldId: "Order Date",
          cumulative: true,
        },
      ],
      catalog(),
    );
    assert.equal(next.metrics.Sales.timeDimensionFieldId, "Ship Date");
    assert.equal(next.metrics.Sales.cumulative, false);
    const percent = applyPulseProposal(
      document,
      [
        {
          op: operation,
          fieldId: "Sales",
          cumulative: true,
          format: "PERCENT",
        },
      ],
      catalog(),
    );
    assert.equal(percent.metrics.Sales.cumulative, false);
  }
});

test("uncertain publication checks the original reviewed command after edits and disconnection", async (t) => {
  let connected: typeof session | null = session;
  const commands: unknown[] = [];
  const { store } = fixture(
    {
      publish: async (_id: string, input: unknown) => {
        commands.push(input);
        if (commands.length === 1) throw new Error("Lost response");
        return receipt();
      },
    },
    () => connected,
  );
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().reviewPublication();
  await store.getState().publishReviewed();
  store.getState().setAudience("New unsaved edits");
  connected = null;
  store.getState().closePreview();
  await store.getState().reviewPublication();
  await store.getState().publishReviewed();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "New unsaved edits",
  );
  assert.equal(activeEditor(store.getState())?.receipt?.id, "receipt");
});

test("a reload response cannot overwrite edits made while the saved version was loading", async (t) => {
  const read = deferred<PulseDraftRecord>();
  let reload = false;
  const { store } = fixture({
    readDraft: async (id: string) => (reload ? read.promise : draft(id)),
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  reload = true;
  const loading = store.getState().openDraft("a", true);
  await Promise.resolve();
  store.getState().setAudience("New edit");
  read.resolve(draft());
  await loading;
  assert.equal(
    activeEditor(store.getState())?.document.digestAudience,
    "New edit",
  );
  assert.match(store.getState().error ?? "", /edits were kept/);
});

test("catalog refreshes ignore older responses and source changes", async (t) => {
  const first = deferred<{ catalog: ReturnType<typeof catalog> }>();
  const newer = deferred<{ catalog: ReturnType<typeof catalog> }>();
  let calls = 0;
  const { transport } = fixture();
  const store = createAuthorController(
    transport,
    async (id) => {
      if (id === "b") return { catalog: catalog("b") };
      return ++calls === 1 ? first.promise : newer.promise;
    },
    () => session,
    () => {},
    60_000,
  );
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  const refreshing = store.getState().refreshCatalog("a", true);
  newer.resolve({ catalog: { ...catalog("a"), datasourceName: "Newest" } });
  await refreshing;
  first.resolve({ catalog: { ...catalog("a"), datasourceName: "Old" } });
  await Promise.resolve();
  assert.equal(store.getState().entries.a.catalog?.datasourceName, "Newest");
  await store.getState().openDraft("b");
  assert.equal(activeEditor(store.getState())?.record.id, "b");
  assert.equal(activeEditor(store.getState())?.catalog?.datasourceLuid, "b");
});

test("publication revision rejection clears approval retry state without losing edits", async (t) => {
  const { store } = fixture({
    publish: async () => {
      throw new PulseApiError(
        "Saved draft changed; review again",
        409,
        "draft_revision_conflict",
      );
    },
  });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  await store.getState().reviewPublication();
  await store.getState().publishReviewed();
  assert.equal(activeEditor(store.getState())?.publishCommandId, null);
  assert.match(
    activeEditor(store.getState())?.publishError ?? "",
    /review again/,
  );
  store.getState().closePreview();
  assert.equal(activeEditor(store.getState())?.preview, null);
});

test("reloading a saved draft invalidates a pending assistant candidate", async (t) => {
  const proposal = deferred<PulseAuthorProposal>();
  const { store } = fixture({ propose: () => proposal.promise });
  t.after(() => store.getState().dispose());
  await store.getState().openDraft("a");
  const pending = store.getState().requestProposal("Original instruction");
  await Promise.resolve();
  await store.getState().openDraft("a", true);
  proposal.resolve({
    baseRevision: 1,
    candidateDocument: {
      ...draft().document,
      digestAudience: "Old suggestion",
    },
    changes: [],
    assistantMessage: "Old",
  });
  await pending;
  assert.equal(activeEditor(store.getState())?.proposal, null);
  assert.equal(activeEditor(store.getState())?.proposalBusy, false);
});
