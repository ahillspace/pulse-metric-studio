import { create } from "zustand";
import { api, type TableauSessionInfo } from "../../../api/client";
import { errorMessage, useNotices } from "../shell/notifications";
import { sessionOwnerKey, setSessionOwner, type SessionOwner } from "../shell/session-events";

export interface DatasourceChoice {
  luid: string;
  name: string;
  projectName: string;
}
interface ConnectionState {
  session: TableauSessionInfo | null;
  checked: boolean;
  reachable: boolean;
  connecting: boolean;
  error: string | null;
  datasources: DatasourceChoice[];
  loadingDatasources: boolean;
  accessChecking: boolean;
  refreshAccess: () => Promise<void>;
  init: () => Promise<void>;
  connected: (
    session: TableauSessionInfo,
    connectionId: string,
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  loadDatasources: () => Promise<void>;
  expireSession: (owner?: SessionOwner | null) => void;
  startAction: () => boolean;
  finishAction: () => void;
  captureOwnerRevision: () => number;
  adoptCommittedSession: (session: TableauSessionInfo, connectionId: string, revision: number) => Promise<boolean>;
}

export function createConnectionController(
  transport: Pick<typeof api, "status" | "disconnect" | "datasources"> = api,
) {
  let generation = 0;
  let sourceRequest = 0;
  let accessRequest = 0;
  let ownerRevision = 0;
  const store = create<ConnectionState>((set, get) => ({
    session: null,
    checked: false,
    reachable: true,
    connecting: false,
    error: null,
    datasources: [],
    loadingDatasources: false,
    accessChecking: false,
    async init() {
      accessRequest++;
      sourceRequest++;
      set({ accessChecking: false, loadingDatasources: false });
      const request = ++generation;
      try {
        const status = await transport.status();
        if (request !== generation) return;
        set({
          checked: true,
          session: status.connected ? (status.session ?? null) : null,
          reachable: status.reachable !== false,
          error: status.availabilityError ?? null,
        });
        if (get().session && get().reachable) await get().loadDatasources();
      } catch (error) {
        if (request === generation)
          set({ checked: true, reachable: false, error: errorMessage(error) });
      }
    },
    async connected(session, connectionId) {
      generation += 1;
      accessRequest++;
      sourceRequest += 1;
      set({
        session: { ...session, connectionId },
        checked: true,
        error: null,
        reachable: true,
        accessChecking: false,
        datasources: [],
      });
      useNotices.getState().show("success", "Connected to Tableau");
      await get().loadDatasources();
    },
    async disconnect() {
      const owner = get().session;
      if (!owner || !get().startAction()) return;
      const request = generation;
      const ownerKey = sessionOwnerKey(owner);
      const current = () => request === generation && ownerKey === sessionOwnerKey(get().session);
      try {
        await transport.disconnect({
          connectionId: owner.connectionId,
          sessionGeneration: owner.sessionGeneration,
        });
        if (!current()) return;
        generation += 1;
        accessRequest += 1;
        sourceRequest += 1;
        set({
          session: null,
          datasources: [],
          loadingDatasources: false,
          accessChecking: false,
          error: null,
        });
        useNotices
          .getState()
          .show(
            "info",
            "Disconnected. Saved drafts and publication history remain available.",
          );
      } catch (error) {
        if (current()) set({ error: errorMessage(error) });
      } finally {
        get().finishAction();
      }
    },
    async loadDatasources() {
      const request = ++sourceRequest;
      const owner = get().session;
      if (!owner) return;
      const ownerGeneration = generation;
      const ownerKey = sessionOwnerKey(owner);
      const current = () => request === sourceRequest && ownerGeneration === generation && ownerKey === sessionOwnerKey(get().session);
      set({ loadingDatasources: true });
      try {
        const response = await transport.datasources();
        if (current()) set({ datasources: response.datasources });
      } catch (error) {
        if (current()) set({ error: errorMessage(error) });
      } finally {
        if (current()) set({ loadingDatasources: false });
      }
    },
    async refreshAccess() {
      const owner = get().session;
      if (!owner || get().accessChecking) return;
      const request = ++accessRequest;
      const ownerGeneration = generation;
      const ownerKey = sessionOwnerKey(owner);
      const current = () => request === accessRequest && ownerGeneration === generation && ownerKey === sessionOwnerKey(get().session);
      set({ accessChecking: true });
      try {
        const status = await transport.status();
        if (!current()) return;
        if (!status.connected) { get().expireSession(owner); return; }
        if (!status.session || sessionOwnerKey(status.session) !== ownerKey) {
          set({ session: { ...get().session!, siteRole: undefined, groupCreation: { state: "unknown", reasonCode: "connection_changed", message: "Group creation permission is not verified for this connection." } }, error: "The Tableau connection changed while checking permissions. Check the current connection before continuing." });
          return;
        }
        const groupCreation = status.session.groupCreation ?? { state: "unknown" as const, reasonCode: "not_verified", message: "Group creation permission is not verified." };
        set({ session: { ...get().session!, ...status.session, siteRole: status.session.siteRole, groupCreation }, error: status.availabilityError ?? null });
      } catch (error) {
        if (current()) set({ session: { ...get().session!, siteRole: undefined, groupCreation: { state: "unknown", reasonCode: "check_failed", message: "Group creation permission is not verified. Try checking permissions again." } }, error: errorMessage(error) });
      } finally { if (request === accessRequest) set({ accessChecking: false }); }
    },
    expireSession(owner = get().session) {
      if (!owner || sessionOwnerKey(owner) !== sessionOwnerKey(get().session)) return;
      generation += 1;
      accessRequest++;
      sourceRequest += 1;
      set({
        session: null,
        datasources: [],
        loadingDatasources: false,
        accessChecking: false,
        error:
          "Your Tableau session ended. Reconnect to continue Tableau actions. Local drafts and history are still available.",
      });
    },
    startAction() {
      if (get().connecting) return false;
      set({ connecting: true, error: null });
      return true;
    },
    finishAction: () => set({ connecting: false }),
    captureOwnerRevision: () => ownerRevision,
    async adoptCommittedSession(session, connectionId, revision) {
      if (revision !== ownerRevision) return false;
      await get().connected(session, connectionId);
      return true;
    },
  }));
  let observedOwner = sessionOwnerKey(store.getState().session);
  store.subscribe((state) => {
    const next = sessionOwnerKey(state.session);
    if (next !== observedOwner) { observedOwner = next; ownerRevision++; }
  });
  return store;
}
export const useConnection = createConnectionController();
useConnection.subscribe((state) => setSessionOwner(state.session));
