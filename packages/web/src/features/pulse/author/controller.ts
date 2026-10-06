import { useRegistry } from "../registry/controller";
import { create } from "zustand";
import {
  PulseWorkspaceDocumentV1Schema,
  defaultPulseMetric,
  reconcilePulseMetric,
  mergePulseProposal,
  type DatasourceCatalog,
  type PulseAuthorProposal,
  type PulseDraftContext,
  type PulseDraftRecord,
  type PulseDraftSummary,
  type PulseMetricDraft,
  type PulsePublishPlan,
  type PulsePublishReceipt,
  type PulseWorkspaceDocumentV1,
} from "@pulse-metric-studio/shared";
import { api, type TableauSessionInfo } from "../../../api/client";
import { notifyLlmHealth } from "../../../llm-health-events";
import { pulseApi, PulseApiError, type PulseApi } from "../api/client";
import {
  useConnection,
  type DatasourceChoice,
} from "../connections/controller";
import { errorMessage } from "../shell/notifications";
import { useActivity } from "../activity/controller";

export interface DraftEditor {
  record: PulseDraftRecord;
  document: PulseWorkspaceDocumentV1;
  sequence: number;
  savedSequence: number;
  saveStatus: "saved" | "pending" | "saving" | "error" | "conflict";
  saveError: string | null;
  catalog: DatasourceCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
  proposal: PulseAuthorProposal | null;
  proposalSequence: number;
  proposalBase: PulseWorkspaceDocumentV1 | null;
  configurationEpoch: number;
  proposalEpoch: number;
  proposalNotice: string | null;
  proposalBusy: boolean;
  proposalMessage: string;
  proposalError: string | null;
  composer: string;
  preview: PulsePublishPlan | null;
  previewSequence: number;
  previewBusy: boolean;
  publishBusy: boolean;
  publishError: string | null;
  publishCommandId: string | null;
  receipt: PulsePublishReceipt | null;
}
type AuthorTransport = Pick<
  PulseApi,
  | "listDrafts"
  | "createDraft"
  | "readDraft"
  | "saveDraft"
  | "deleteDraft"
  | "propose"
  | "preview"
  | "publish"
>;
interface AuthorState {
  drafts: PulseDraftSummary[];
  draftTotal: number;
  draftOffset: number;
  draftQuery: string;
  entries: Record<string, DraftEditor>;
  activeId: string | null;
  loading: boolean;
  error: string | null;
  loadDrafts: (offset?: number, query?: string) => Promise<void>;
  openDraft: (id: string, reload?: boolean) => Promise<void>;
  selectDatasource: (source: DatasourceChoice) => Promise<void>;
  refreshCatalog: (id?: string, refresh?: boolean) => Promise<void>;
  edit: (change: (document: PulseWorkspaceDocumentV1) => void) => void;
  updateMetric: (id: string, patch: Partial<PulseMetricDraft>) => void;
  toggleMetric: (id: string) => void;
  toggleSlicer: (id: string) => void;
  setAudience: (value: string) => void;
  setAudienceLocked: (value: boolean) => void;
  setGroupFollow: (value: boolean) => void;
  clearConfiguration: () => void;
  setComposer: (value: string) => void;
  flush: (id?: string) => Promise<PulseDraftRecord>;
  removeDraft: (id: string) => Promise<void>;
  requestProposal: (message: string) => Promise<void>;
  acceptProposal: () => Promise<void>;
  discardProposal: () => void;
  reviewPublication: () => Promise<void>;
  closePreview: () => void;
  publishReviewed: () => Promise<void>;
  closeReceipt: () => void;
  dispose: () => void;
}

export function contextMatches(
  context: PulseDraftContext,
  session: TableauSessionInfo | null,
): boolean {
  return Boolean(
    session &&
      session.connectionId === context.connectionId &&
      session.serverUrl === context.serverUrl &&
      session.siteId === context.siteId,
  );
}
export function activeEditor(
  state: Pick<AuthorState, "activeId" | "entries">,
): DraftEditor | null {
  return state.activeId ? (state.entries[state.activeId] ?? null) : null;
}
export function proposalIsStale(entry: DraftEditor): boolean {
  // Proposals merge against current values; unrelated edits do not invalidate them.
  return false;
}
export function previewIsStale(entry: DraftEditor): boolean {
  return Boolean(
    entry.preview &&
      (entry.preview.revision !== entry.record.revision ||
        entry.previewSequence !== entry.sequence),
  );
}

function editor(record: PulseDraftRecord): DraftEditor {
  return {
    record,
    document: structuredClone(record.document),
    sequence: 0,
    savedSequence: 0,
    saveStatus: "saved",
    saveError: null,
    catalog: null,
    catalogLoading: false,
    catalogError: null,
    proposal: null,
    proposalSequence: 0,
    proposalBase: null,
    configurationEpoch: 0,
    proposalEpoch: 0,
    proposalNotice: null,
    proposalBusy: false,
    proposalMessage: "",
    proposalError: null,
    composer: "",
    preview: null,
    previewSequence: 0,
    previewBusy: false,
    publishBusy: false,
    publishError: null,
    publishCommandId: null,
    receipt: null,
  };
}

export function createAuthorController(
  transport: AuthorTransport = pulseApi,
  catalogTransport: typeof api.fields = api.fields,
  session: () => TableauSessionInfo | null = () =>
    useConnection.getState().session,
  onReceipt: (receipt: PulsePublishReceipt) => void = () => {},
  debounceMs = 600,
  onInventoryChanged: (context: PulseDraftContext) => void = () => {},
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const writers = new Map<string, Promise<PulseDraftRecord>>();
  const catalogRequests = new Map<string, number>();
  const proposalRequests = new Map<string, number>();
  let navigation = 0;
  let listRequest = 0;
  const store = create<AuthorState>((set, get) => {
    const update = (
      id: string,
      change:
        | Partial<DraftEditor>
        | ((entry: DraftEditor) => Partial<DraftEditor>),
    ) => {
      set((state) => {
        const entry = state.entries[id];
        return entry
          ? {
              entries: {
                ...state.entries,
                [id]: {
                  ...entry,
                  ...(typeof change === "function" ? change(entry) : change),
                },
              },
            }
          : {};
      });
    };
    const remember = (record: PulseDraftRecord) =>
      set((state) => ({
        drafts: state.drafts.map((draft) =>
          draft.id === record.id ? record : draft,
        ),
      }));
    const schedule = (id: string) => {
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void get()
            .flush(id)
            .catch(() => {});
        }, debounceMs),
      );
    };
    const requireRemote = (entry: DraftEditor) => {
      if (!contextMatches(entry.record.context, session()))
        throw new Error(
          "Connect to this draft's Tableau connection and site to continue.",
        );
    };
    return {
      drafts: [],
      draftTotal: 0,
      draftOffset: 0,
      draftQuery: "",
      entries: {},
      activeId: null,
      loading: false,
      error: null,
      async loadDrafts(offset = get().draftOffset, query = get().draftQuery) {
        const request = ++listRequest;
        const owner = session();
        try {
          const page = await transport.listDrafts({
            offset,
            limit: 10,
            q: query,
            ...(owner
              ? {
                  connectionId: owner.connectionId,
                  serverUrl: owner.serverUrl,
                  siteId: owner.siteId,
                }
              : {}),
          });
          if (request === listRequest)
            set({
              drafts: page.drafts,
              draftTotal: page.total,
              draftOffset: page.offset,
              draftQuery: query,
              error: null,
            });
          if (
            request === listRequest &&
            !get().activeId &&
            !get().loading &&
            page.drafts.length
          ) {
            const last =
              page.drafts.find((draft) =>
                contextMatches(draft.context, session()),
              ) ?? (!session() ? page.drafts[0] : undefined);
            if (last) await get().openDraft(last.id);
          }
        } catch (error) {
          if (request === listRequest) set({ error: errorMessage(error) });
        }
      },
      async openDraft(id, reload = false) {
        const request = ++navigation;
        set({ loading: true, error: null });
        try {
          let entry = get().entries[id];
          if (!entry || reload) {
            if (reload) {
              clearTimeout(timers.get(id));
              await writers.get(id)?.catch(() => {});
            }
            const beforeRead = get().entries[id];
            const sequenceBeforeRead = beforeRead?.sequence;
            const record = await transport.readDraft(id);
            if (request !== navigation) return;
            if (get().entries[id]?.sequence !== sequenceBeforeRead) {
              set({
                loading: false,
                error:
                  "This draft was edited while reloading. Your edits were kept.",
              });
              return;
            }
            proposalRequests.set(id, (proposalRequests.get(id) ?? 0) + 1);
            entry = editor(record);
            if (beforeRead?.publishCommandId) {
              entry.preview = beforeRead.preview;
              entry.previewSequence = beforeRead.previewSequence;
              entry.publishCommandId = beforeRead.publishCommandId;
              entry.publishError = beforeRead.publishError;
            }
            set((state) => ({ entries: { ...state.entries, [id]: entry! } }));
            remember(record);
          }
          if (request !== navigation) return;
          set({ activeId: id, loading: false });
          if (contextMatches(entry.record.context, session()))
            void get().refreshCatalog(id);
        } catch (error) {
          if (request === navigation)
            set({ loading: false, error: errorMessage(error) });
        }
      },
      async selectDatasource(source) {
        const owner = session();
        if (!owner?.connectionId) {
          set({
            error:
              "Connect to a saved Tableau connection before selecting a datasource.",
          });
          return;
        }
        const request = ++navigation;
        set({ loading: true, error: null });
        try {
          const record = await transport.createDraft({
            context: {
              connectionId: owner.connectionId,
              serverUrl: owner.serverUrl,
              siteId: owner.siteId,
              datasourceLuid: source.luid,
            },
            datasourceName: source.name,
          });
          remember(record);
          void get().loadDrafts(0);
          if (!get().entries[record.id])
            set((state) => ({
              entries: { ...state.entries, [record.id]: editor(record) },
            }));
          if (request !== navigation || owner !== session()) return;
          set({ activeId: record.id, loading: false });
          await get().refreshCatalog(record.id);
        } catch (error) {
          if (request === navigation)
            set({ loading: false, error: errorMessage(error) });
        }
      },
      async refreshCatalog(id = get().activeId ?? undefined, refresh = false) {
        if (!id) return;
        const entry = get().entries[id];
        if (!entry || !contextMatches(entry.record.context, session())) return;
        const owner = session();
        const request = (catalogRequests.get(id) ?? 0) + 1;
        catalogRequests.set(id, request);
        update(id, { catalogLoading: true, catalogError: null });
        try {
          const { catalog } = await catalogTransport(
            entry.record.context.datasourceLuid,
            refresh,
          );
          if (catalogRequests.get(id) !== request || owner !== session())
            return;
          update(id, (current) => {
            const document = PulseWorkspaceDocumentV1Schema.parse({
              ...current.document,
              metrics: Object.fromEntries(
                Object.entries(current.document.metrics).map(
                  ([key, metric]) => [
                    key,
                    reconcilePulseMetric(catalog, metric),
                  ],
                ),
              ),
            });
            const changed =
              JSON.stringify(document) !== JSON.stringify(current.document);
            if (changed) schedule(id);
            return {
              catalog,
              catalogLoading: false,
              document,
              ...(changed
                ? {
                    sequence: current.sequence + 1,
                    saveStatus: "pending" as const,
                  }
                : {}),
            };
          });
        } catch (error) {
          if (catalogRequests.get(id) === request)
            update(id, { catalogError: errorMessage(error) });
        } finally {
          if (catalogRequests.get(id) === request)
            update(id, { catalogLoading: false });
        }
      },
      edit(change) {
        const entry = activeEditor(get());
        if (!entry) return;
        const document = structuredClone(entry.document);
        change(document);
        update(entry.record.id, {
          document: PulseWorkspaceDocumentV1Schema.parse(document),
          sequence: entry.sequence + 1,
          saveStatus: entry.saveStatus === "conflict" ? "conflict" : "pending",
          saveError: entry.saveStatus === "conflict" ? entry.saveError : null,
        });
        if (entry.saveStatus !== "conflict") schedule(entry.record.id);
      },
      updateMetric(id, patch) {
        const entry = activeEditor(get());
        if (!entry?.document.metrics[id]) return;
        get().edit((document) => {
          let metric = { ...document.metrics[id], ...patch };
          metric.locks = [
            ...new Set([
              ...metric.locks,
              ...Object.keys(patch).filter((key) => key !== "locks"),
            ]),
          ];
          if (entry.catalog)
            metric = reconcilePulseMetric(entry.catalog, metric);
          else if (
            metric.aggregation !== "SUM" ||
            metric.format === "PERCENT" ||
            metric.temporality === "LATEST"
          )
            metric.cumulative = false;
          document.metrics[id] = metric;
        });
      },
      toggleMetric(id) {
        const entry = activeEditor(get());
        if (!entry) return;
        get().edit((document) => {
          const current = document.metrics[id];
          if (current) current.active = !current.active;
          else if (entry.catalog) {
            const metric = defaultPulseMetric(entry.catalog, id);
            if (metric) document.metrics[id] = metric;
          }
        });
      },
      toggleSlicer(id) {
        const entry = activeEditor(get());
        if (!entry) return;
        get().edit((document) => {
          if (document.slicers[id])
            document.slicers[id].active = !document.slicers[id].active;
          else {
            const field = entry.catalog?.dimensions.find(
              (value) => value.id === id,
            );
            if (field)
              document.slicers[id] = {
                active: true,
                fieldId: id,
                fieldLabel: field.label,
              };
          }
        });
      },
      setAudience: (value) =>
        get().edit((document) => {
          document.digestAudience = value;
        }),
      setAudienceLocked: (value) =>
        get().edit((document) => {
          document.digestAudienceLocked = value;
        }),
      setGroupFollow: (value) =>
        get().edit((document) => {
          document.groupFollow = value;
        }),
      clearConfiguration: () => {
        const entry = activeEditor(get());
        if (!entry) return;
        update(entry.record.id, {
          configurationEpoch: entry.configurationEpoch + 1,
        });
        get().edit((document) => {
          document.metrics = {};
          document.slicers = {};
        });
      },
      setComposer(value) {
        const id = get().activeId;
        if (id) update(id, { composer: value });
      },
      async flush(id = get().activeId ?? undefined) {
        if (!id || !get().entries[id])
          throw new Error("Open a draft before saving.");
        clearTimeout(timers.get(id));
        timers.delete(id);
        const running = writers.get(id);
        if (running) {
          await running;
          return get().flush(id);
        }
        const pending = get().entries[id];
        if (pending.saveStatus === "conflict")
          throw new Error(
            pending.saveError ??
              "Review the changed saved draft before saving again.",
          );
        if (pending.savedSequence === pending.sequence) return pending.record;
        const write = (async () => {
          while (true) {
            const snapshot = get().entries[id];
            if (!snapshot) throw new Error("This draft is no longer open.");
            if (snapshot.savedSequence === snapshot.sequence)
              return snapshot.record;
            update(id, { saveStatus: "saving", saveError: null });
            try {
              const record = await transport.saveDraft(id, {
                expectedRevision: snapshot.record.revision,
                document: snapshot.document,
              });
              update(id, (current) => ({
                record,
                savedSequence: snapshot.sequence,
                saveStatus:
                  current.sequence === snapshot.sequence ? "saved" : "pending",
                ...(current.sequence === snapshot.sequence
                  ? { document: structuredClone(record.document) }
                  : {}),
              }));
              remember(record);
            } catch (error) {
              update(id, {
                saveStatus:
                  error instanceof PulseApiError && error.status === 409
                    ? "conflict"
                    : "error",
                saveError: errorMessage(error),
              });
              throw error;
            }
          }
        })();
        writers.set(id, write);
        try {
          return await write;
        } finally {
          writers.delete(id);
        }
      },
      async removeDraft(id) {
        try {
          if (get().entries[id]?.publishCommandId)
            throw new Error(
              "Check the unconfirmed publication before deleting this draft.",
            );
          const record = get().entries[id]
            ? await get().flush(id)
            : await transport.readDraft(id);
          await transport.deleteDraft(id, record.revision);
          clearTimeout(timers.get(id));
          set((state) => {
            const entries = { ...state.entries };
            delete entries[id];
            return {
              entries,
              drafts: state.drafts.filter((draft) => draft.id !== id),
              activeId: state.activeId === id ? null : state.activeId,
              draftTotal: Math.max(0, state.draftTotal - 1),
            };
          });
        } catch (error) {
          set({ error: errorMessage(error) });
        }
      },
      async requestProposal(message) {
        const entry = activeEditor(get());
        if (!entry || entry.proposalBusy || !message.trim()) return;
        const id = entry.record.id;
        const request = (proposalRequests.get(id) ?? 0) + 1;
        proposalRequests.set(id, request);
        update(id, {
          proposalBusy: true,
          proposalError: null,
          proposalMessage: message,
          proposal: null,
          proposalNotice: null,
        });
        try {
          requireRemote(entry);
          const snapshot = get().entries[id];
          const document = structuredClone(snapshot.document);
          const sequence = snapshot.sequence;
          update(id, {
            proposalBase: document,
            proposalEpoch: snapshot.configurationEpoch,
            document: {
              ...document,
              chat: [
                ...document.chat,
                { role: "user", content: message, ts: Date.now() },
              ],
            },
            sequence: sequence + 1,
            saveStatus:
              snapshot.saveStatus === "conflict" ? "conflict" : "pending",
          });
          // Disk failure must not prevent a model from using the current in-memory selection.
          void get()
            .flush(id)
            .catch(() => {});
          const proposal = await transport.propose(
            id,
            snapshot.record.revision,
            message,
            document,
          );
          if (proposalRequests.get(id) !== request) return;
          update(id, (current) => ({
            proposal,
            proposalSequence: sequence,
            composer: current.composer.trim() === message.trim() ? "" : current.composer,
            document: {
              ...current.document,
              chat: [
                ...current.document.chat,
                {
                  role: "assistant",
                  content: proposal.assistantMessage,
                  ts: Date.now(),
                  proposalContext:
                    proposal.candidateDocument.chat.at(-1)?.proposalContext ??
                    JSON.stringify({
                      metrics: proposal.candidateDocument.metrics,
                      slicers: proposal.candidateDocument.slicers,
                      digestAudience: proposal.candidateDocument.digestAudience,
                    }),
                },
              ],
            },
            sequence: current.sequence + 1,
          }));
          await get()
            .flush(id)
            .catch(() => {});
          notifyLlmHealth(true);
        } catch (error) {
          if (proposalRequests.get(id) !== request) return;
          update(id, { proposalError: errorMessage(error) });
          notifyLlmHealth(false);
        } finally {
          if (proposalRequests.get(id) === request)
            update(id, { proposalBusy: false });
        }
      },
      async acceptProposal() {
        const entry = activeEditor(get());
        if (!entry?.proposal || !entry.proposalBase) return;
        const id = entry.record.id;
        const merged = mergePulseProposal(
          entry.proposalBase,
          entry.proposal.candidateDocument,
          entry.document,
          entry.proposalEpoch !== entry.configurationEpoch,
        );
        update(id, {
          document: merged.document,
          sequence: entry.sequence + 1,
          saveStatus: "pending",
          proposal: null,
          proposalNotice: merged.skipped.length
            ? "Applied compatible suggestions and kept your newer or protected changes."
            : "Applied the proposed changes.",
        });
        try {
          await get().flush(id);
        } catch {
          /* The save state retains the unsaved candidate and its error. */
        }
      },
      discardProposal() {
        const id = get().activeId;
        if (id) update(id, { proposal: null, proposalError: null });
      },
      async reviewPublication() {
        const entry = activeEditor(get());
        if (
          !entry ||
          entry.previewBusy ||
          entry.publishBusy ||
          entry.publishCommandId
        )
          return;
        const id = entry.record.id;
        update(id, {
          previewBusy: true,
          publishError: null,
          preview: null,
          publishCommandId: null,
        });
        try {
          requireRemote(entry);
          const record = await get().flush(id);
          const sequence = get().entries[id].sequence;
          const preview = await transport.preview(id, record.revision);
          update(id, { preview, previewSequence: sequence });
        } catch (error) {
          update(id, { publishError: errorMessage(error) });
        } finally {
          update(id, { previewBusy: false });
        }
      },
      closePreview() {
        const id = get().activeId;
        if (id && !get().entries[id]?.publishCommandId)
          update(id, { preview: null });
      },
      async publishReviewed() {
        const entry = activeEditor(get());
        if (
          !entry?.preview ||
          entry.publishBusy ||
          (previewIsStale(entry) && !entry.publishCommandId) ||
          entry.preview.issues.length > 0
        )
          return;
        const id = entry.record.id;
        const commandId =
          entry.publishCommandId ?? globalThis.crypto.randomUUID();
        update(id, {
          publishBusy: true,
          publishError: null,
          publishCommandId: commandId,
        });
        let sent = false;
        try {
          if (!entry.publishCommandId) requireRemote(entry);
          sent = true;
          const receipt = await transport.publish(id, {
            expectedRevision: entry.preview.revision,
            previewFingerprint: entry.preview.previewFingerprint,
            commandId,
          });
          update(id, { receipt, preview: null, publishCommandId: null });
          onReceipt(receipt);
        } catch (error) {
          const message =
            error instanceof PulseApiError
              ? error.message
              : `${errorMessage(error)} The response is unconfirmed. Check Activity or check this submission again before starting another publication.`;
          update(id, {
            publishError: message,
            ...(error instanceof PulseApiError && error.status < 500
              ? { publishCommandId: null }
              : {}),
          });
        } finally {
          update(id, { publishBusy: false });
          if (sent) onInventoryChanged(entry.preview.context);
        }
      },
      closeReceipt() {
        const id = get().activeId;
        if (id) update(id, { receipt: null });
      },
      dispose() {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        navigation += 1;
      },
    };
  });
  return store;
}

export const useAuthor = createAuthorController(
  pulseApi,
  api.fields,
  () => useConnection.getState().session,
  (receipt) => {
    useActivity.getState().received(receipt);
  },
  600,
  (context) => { void useRegistry.getState().invalidate(context); },
);
