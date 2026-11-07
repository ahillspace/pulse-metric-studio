import { useRegistry } from "../registry/controller";
import { create } from "zustand";
import type {
  PulseDraftContext,
  PulsePublishReceipt,
  PulsePublishReceiptSummary,
} from "@pulse-metric-studio/shared";
import { pulseApi, PulseApiError, type PulseApi } from "../api/client";
import { errorMessage } from "../shell/notifications";
import { captureSessionOwner, type SessionOwner } from "../shell/session-events";
import { createMutationJobTracker, stoppedMessage, type MutationJobProgress } from "../jobs/tracker";

interface ActivityState {
  receipts: PulsePublishReceiptSummary[];
  total: number;
  offset: number;
  query: string;
  selected: PulsePublishReceipt | null;
  receiptById: Record<string, PulsePublishReceipt>;
  loading: boolean;
  undoBusy: boolean;
  groupBusy: boolean;
  /** Why the last group deletion did not finish, including a stop before it was sent. */
  groupError: string | null;
  groupReceiptId: string | null;
  /** Why the last undo did not finish, including a stop before every deletion was sent. */
  undoError: string | null;
  undoReceiptId: string | null;
  /** The running undo or group deletion, once the server reports it as a job. */
  job: MutationJobProgress | null;
  /** Stops sending the running undo or group deletion; completed deletions stay done. */
  cancelJob: () => Promise<void>;
  readError: string | null;
  readReceiptId: string | null;
  error: string | null;
  load: (offset?: number, query?: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  close: () => void;
  received: (receipt: PulsePublishReceipt) => void;
  undo: (id: string) => Promise<void>;
  deleteGroup: (id: string, groupId: string) => Promise<void>;
}
export function createActivityController(
  transport: Pick<PulseApi, "listReceipts" | "readReceipt" | "undo" | "cancelJob"> = pulseApi,
  deleteGroup: PulseApi["deletePublicationGroup"] = pulseApi.deletePublicationGroup,
  onInventoryChanged: (context: PulseDraftContext | null, owner: SessionOwner | null, directoryChanged: boolean) => void = () => {},
) {
  let listRequest = 0;
  let selectionRequest = 0;
  /** Undo and group deletion never overlap, so one tracker follows whichever is running. */
  const jobs = createMutationJobTracker((id, owner) => transport.cancelJob(id, owner));
  return create<ActivityState>((set, get) => {
    const beginJob = (owner: SessionOwner | null) => jobs.begin({
      owner, total: null, current: () => true, read: () => get().job, write: (job) => set({ job }),
    });
    return {
    receipts: [],
    total: 0,
    offset: 0,
    query: "",
    selected: null,
    receiptById: {},
    loading: false,
    undoBusy: false,
    groupBusy: false,
    groupError: null,
    groupReceiptId: null,
    undoError: null,
    undoReceiptId: null,
    job: null,
    async cancelJob() {
      await jobs.cancel();
    },
    readError: null,
    readReceiptId: null,
    error: null,
    async load(offset = get().offset, query = get().query) {
      const request = ++listRequest;
      set({ loading: true, error: null });
      try {
        let page = await transport.listReceipts({
          offset,
          limit: 20,
          q: query,
        });
        if (request !== listRequest) return;
        const lastOffset = Math.max(0, Math.floor((page.total - 1) / 20) * 20);
        if (page.offset > lastOffset) {
          page = await transport.listReceipts({
            offset: lastOffset,
            limit: 20,
            q: query,
          });
        }
        if (request === listRequest)
          set({
            receipts: page.receipts,
            total: page.total,
            offset: page.offset,
            query,
          });
      } catch (error) {
        if (request === listRequest) set({ error: errorMessage(error) });
      } finally {
        if (request === listRequest) set({ loading: false });
      }
    },
    async open(id) {
      if (get().undoBusy || get().groupBusy) return;
      const request = ++selectionRequest;
      set({ error: null, readError: null, readReceiptId: id });
      try {
        const selected = await transport.readReceipt(id);
        if (request === selectionRequest) {
          get().received(selected);
          set({ selected });
        }
      } catch (error) {
        if (request === selectionRequest)
          set({ error: errorMessage(error), readError: errorMessage(error) });
      }
    },
    close() {
      selectionRequest += 1;
      set({ selected: null });
    },
    received(receipt) {
      set((state) => ({
        receiptById: { ...state.receiptById, [receipt.id]: receipt },
        receipts: state.receipts.map((item) =>
          item.id === receipt.id ? receipt : item,
        ),
        ...(state.selected?.id === receipt.id ? { selected: receipt } : {}),
      }));
    },
    async deleteGroup(id, groupId) {
      if (get().undoBusy || get().groupBusy) return;
      const context = get().receiptById[id]?.context ?? null;
      const owner = captureSessionOwner();
      const request = ++selectionRequest;
      let directoryChanged = false;
      const before = JSON.stringify(get().receiptById[id]?.follow.group.deletion ?? null);
      set({ groupBusy: true, groupError: null, groupReceiptId: id });
      const job = beginJob(owner);
      try {
        const receipt = await deleteGroup(id, groupId, job.observe);
        const deletion = receipt.follow.group.deletion;
        directoryChanged = deletion?.status === "deleted" || deletion?.status === "unknown";
        get().received(receipt);
        if (request === selectionRequest) set({ selected: receipt });
        // A stopped deletion that was never sent leaves the receipt as it was;
        // an unconfirmed one keeps its own warning.
        if (job.stopReason && deletion?.status !== "unknown" && JSON.stringify(deletion ?? null) === before)
          set({ groupError: stoppedMessage(job.stopReason, "The group deletion", "The group was not deleted.") });
      } catch (error) {
        directoryChanged = !(error instanceof PulseApiError) || error.status >= 500;
        set({ groupError: errorMessage(error) });
      } finally {
        job.end();
        if (context || directoryChanged) onInventoryChanged(context, owner, directoryChanged);
        set({ groupBusy: false });
      }
    },
    async undo(id) {
      if (get().undoBusy || get().groupBusy) return;
      selectionRequest += 1;
      const request = selectionRequest;
      const owner = captureSessionOwner();
      set({ undoBusy: true, error: null, undoError: null, undoReceiptId: id });
      const job = beginJob(owner);
      try {
        const receipt = await transport.undo(id, job.observe);
        get().received(receipt);
        if (request === selectionRequest) set({ selected: receipt });
        if (job.stopReason && receipt.undoEligible)
          set({ undoError: stoppedMessage(job.stopReason, "The undo", "Deleted metrics stay deleted; the rest were not sent.") });
      } catch (error) {
        set({ error: errorMessage(error), undoError: errorMessage(error) });
      } finally {
        job.end();
        const context = get().receiptById[id]?.context;
        if (context) onInventoryChanged(context, owner, false);
        set({ undoBusy: false });
      }
    },
    };
  });
}
export const useActivity = createActivityController(pulseApi, pulseApi.deletePublicationGroup, (context, owner, directoryChanged) => {
  if (directoryChanged) useRegistry.getState().invalidateTargets(owner);
  void useRegistry.getState().invalidate(context, owner);
});
