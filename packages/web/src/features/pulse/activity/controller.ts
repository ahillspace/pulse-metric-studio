import { useRegistry } from "../registry/controller";
import { create } from "zustand";
import type {
  PulseDraftContext,
  PulsePublishReceipt,
  PulsePublishReceiptSummary,
} from "@pulse-metric-studio/shared";
import { pulseApi, type PulseApi } from "../api/client";
import { errorMessage } from "../shell/notifications";

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
  groupError: string | null;
  groupReceiptId: string | null;
  undoError: string | null;
  undoReceiptId: string | null;
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
  transport: Pick<PulseApi, "listReceipts" | "readReceipt" | "undo"> = pulseApi,
  deleteGroup: PulseApi["deletePublicationGroup"] = pulseApi.deletePublicationGroup,
  onInventoryChanged: (context: PulseDraftContext | null) => void = () => {},
) {
  let listRequest = 0;
  let selectionRequest = 0;
  return create<ActivityState>((set, get) => ({
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
      const request = ++selectionRequest;
      set({ groupBusy: true, groupError: null, groupReceiptId: id });
      try {
        const receipt = await deleteGroup(id, groupId);
        get().received(receipt);
        if (request === selectionRequest) set({ selected: receipt });
      } catch (error) {
        set({ groupError: errorMessage(error) });
      } finally {
        if (context) onInventoryChanged(context);
        set({ groupBusy: false });
      }
    },
    async undo(id) {
      if (get().undoBusy || get().groupBusy) return;
      selectionRequest += 1;
      const request = selectionRequest;
      set({ undoBusy: true, error: null, undoError: null, undoReceiptId: id });
      try {
        const receipt = await transport.undo(id);
        get().received(receipt);
        if (request === selectionRequest) set({ selected: receipt });
      } catch (error) {
        set({ error: errorMessage(error), undoError: errorMessage(error) });
      } finally {
        const context = get().receiptById[id]?.context;
        if (context) onInventoryChanged(context);
        set({ undoBusy: false });
      }
    },
  }));
}
export const useActivity = createActivityController(pulseApi, pulseApi.deletePublicationGroup, (context) => {
  void useRegistry.getState().invalidate(context);
});
