import { create } from "zustand";
import { api, type TableauSessionInfo } from "../../../api/client";
import { errorMessage, useNotices } from "../shell/notifications";

export interface DatasourceChoice {
  luid: string;
  name: string;
  projectName: string;
}
interface ConnectionState {
  session: TableauSessionInfo | null;
  checked: boolean;
  connecting: boolean;
  error: string | null;
  datasources: DatasourceChoice[];
  loadingDatasources: boolean;
  init: () => Promise<void>;
  connected: (
    session: TableauSessionInfo,
    connectionId: string,
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  loadDatasources: () => Promise<void>;
  expireSession: () => void;
  startAction: () => void;
  finishAction: () => void;
}

export function createConnectionController(
  transport: Pick<typeof api, "status" | "disconnect" | "datasources"> = api,
) {
  let generation = 0;
  let sourceRequest = 0;
  return create<ConnectionState>((set, get) => ({
    session: null,
    checked: false,
    connecting: false,
    error: null,
    datasources: [],
    loadingDatasources: false,
    async init() {
      const request = ++generation;
      try {
        const status = await transport.status();
        if (request !== generation) return;
        set({
          checked: true,
          session: status.connected ? (status.session ?? null) : null,
          error: null,
        });
        if (get().session) await get().loadDatasources();
      } catch (error) {
        if (request === generation)
          set({ checked: true, session: null, error: errorMessage(error) });
      }
    },
    async connected(session, connectionId) {
      generation += 1;
      sourceRequest += 1;
      set({
        session: { ...session, connectionId },
        checked: true,
        error: null,
        datasources: [],
      });
      useNotices.getState().show("success", "Connected to Tableau");
      await get().loadDatasources();
    },
    async disconnect() {
      const owner = get().session;
      const request = generation;
      try {
        await transport.disconnect();
        if (request !== generation || owner !== get().session) return;
        generation += 1;
        sourceRequest += 1;
        set({
          session: null,
          datasources: [],
          loadingDatasources: false,
          error: null,
        });
        useNotices
          .getState()
          .show(
            "info",
            "Disconnected. Saved drafts and publication history remain available.",
          );
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    },
    async loadDatasources() {
      const request = ++sourceRequest;
      const owner = get().session;
      if (!owner) return;
      set({ loadingDatasources: true });
      try {
        const response = await transport.datasources();
        if (request === sourceRequest && get().session === owner)
          set({ datasources: response.datasources });
      } catch (error) {
        if (request === sourceRequest) set({ error: errorMessage(error) });
      } finally {
        if (request === sourceRequest) set({ loadingDatasources: false });
      }
    },
    expireSession() {
      generation += 1;
      sourceRequest += 1;
      set({
        session: null,
        datasources: [],
        loadingDatasources: false,
        error:
          "Your Tableau session ended. Reconnect to continue Tableau actions. Local drafts and history are still available.",
      });
    },
    startAction: () => set({ connecting: true, error: null }),
    finishAction: () => set({ connecting: false }),
  }));
}
export const useConnection = createConnectionController();
