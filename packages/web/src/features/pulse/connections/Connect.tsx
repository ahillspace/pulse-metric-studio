import { useEffect, useMemo, useRef, useState } from "react";
import { SAVED_SECRET_PLACEHOLDER } from "@pulse-metric-studio/shared";
import { useConnection } from "./controller";
import { useNotices } from "../shell/notifications";
import { BusyLabel } from "../components/ui";
import { replaceNativeCredential } from "./credential-replacement";
import {
  canCompensateStagedCredential,
  deleteNativeCredential,
  getCredentialCapability,
  restoredConnectionFields,
  storeNativeCredential,
  tableauConnectionsApi,
  type ConnectionSummary,
  type CredentialCapability,
  type CredentialStorageKind,
  type TableauSessionInfo,
} from "../../../tableau-connections-api";
export function ConnectCard() {
  const connecting = useConnection((state) => state.connecting);
  const storeError = useConnection((state) => state.error);

  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [capability, setCapability] = useState<CredentialCapability | null>(
    null,
  );
  const [serverUrl, setServerUrl] = useState("https://");
  const [siteContentUrl, setSiteContentUrl] = useState("");
  const [patName, setPatName] = useState("");
  const patSecretRef = useRef<HTMLInputElement>(null);
  const [hasPatSecret, setHasPatSecret] = useState(false);
  const [storageKind, setStorageKind] = useState<CredentialStorageKind | "">(
    "",
  );
  const [fallbackConfirmed, setFallbackConfirmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retirements, setRetirements] = useState<Array<{ ticket: string; connectionId: string }>>([]);
  const [retirementCheckFailed, setRetirementCheckFailed] = useState(false);
  const retirementGeneration = useRef(0);

  const selected = useMemo(
    () =>
      connections.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );
  const error = localError ?? storeError;
  const browserFallback = capability?.platform === "browser";

  useEffect(() => {
    let cancelled = false;
    const retirementRequest = ++retirementGeneration.current;
    void tableauConnectionsApi.listCredentialRetirements().then((pending) => {
      if (!cancelled && retirementGeneration.current === retirementRequest) { setRetirements(pending); setRetirementCheckFailed(false); }
    }).catch(() => {
      if (!cancelled && retirementGeneration.current === retirementRequest) {
        setRetirementCheckFailed(true);
        useNotices.getState().show("warning", "Could not check previous credential cleanup. Open Connections to retry.");
      }
    });
    void Promise.all([tableauConnectionsApi.list(), getCredentialCapability()])
      .then(([savedConnections, credentialCapability]) => {
        if (cancelled) return;
        setConnections(savedConnections);
        setCapability(credentialCapability);
        if (credentialCapability.available) setStorageKind("os");
        const active = savedConnections.find(
          (connection) => connection.isActive,
        );
        if (active) selectConnection(active);
      })
      .catch((loadError) => {
        if (!cancelled) setLocalError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectConnection(connection: ConnectionSummary | null): void {
    setSelectedId(connection?.id ?? "");
    setConfirmDelete(false);
    setFallbackConfirmed(false);
    clearPatSecret();
    setLocalError(null);
    if (connection) {
      const restored = restoredConnectionFields(connection);
      setServerUrl(restored.serverUrl);
      setSiteContentUrl(restored.siteContentUrl);
      setPatName(restored.patName);
      setStorageKind(connection.storageKind);
      return;
    }
    setServerUrl("https://");
    setSiteContentUrl("");
    setPatName("");
    setStorageKind(capability?.available ? "os" : "");
  }

  async function reloadConnections(preferredId?: string): Promise<void> {
    const savedConnections = await tableauConnectionsApi.list();
    setConnections(savedConnections);
    const next =
      savedConnections.find((connection) => connection.id === preferredId) ??
      savedConnections.find((connection) => connection.isActive) ??
      null;
    if (next) selectConnection(next);
  }

  async function finishConnection(
    session: TableauSessionInfo,
    connectionId: string,
    revision: number,
  ): Promise<void> {
    if (!await useConnection.getState().adoptCommittedSession(session, connectionId, revision)) {
      throw new Error("A newer Tableau connection was observed. Check the current connection before continuing.");
    }
    await reloadConnections(connectionId);
  }

  function readPatSecret(): string {
    return patSecretRef.current?.value ?? "";
  }

  function clearPatSecret(): void {
    if (patSecretRef.current) patSecretRef.current.value = "";
    setHasPatSecret(false);
  }

  async function finishCommittedMutation(
    response: Awaited<ReturnType<typeof tableauConnectionsApi.connect>>,
    revision: number,
  ): Promise<void> {
    clearPatSecret();
    if (response.superseded) {
      await useConnection.getState().reconcileActiveSession(revision);
      await reloadConnections();
      throw new Error("A later connection change replaced this result. Check the current connection before continuing.");
    }
    if (response.session) {
      await finishConnection(response.session, response.connection.id, revision);
      return;
    }
    await reloadConnections(response.connection.id);
    throw new Error(
      response.activationError?.message ??
        "The connection was saved, but Tableau activation could not be confirmed. Use the saved connection to retry.",
    );
  }

  async function runConnectionAction(
    action: (ownerRevision: number) => Promise<void>,
  ): Promise<void> {
    if (!useConnection.getState().startAction()) return;
    const ownerRevision = useConnection.getState().captureOwnerRevision();
    setLocalError(null);
    try {
      await action(ownerRevision);
    } catch (actionError) {
      setLocalError(errorMessage(actionError));
    } finally {
      useConnection.getState().finishAction();
    }
  }

  async function connectNew(): Promise<void> {
    await runConnectionAction(async (ownerRevision) => {
      if (storageKind === "os") {
        if (!capability?.available)
          throw new Error(
            capability?.reason ?? "OS credential storage is unavailable.",
          );
        const secret = readPatSecret();
        const credentialRef = await storeNativeCredential({
          serverUrl,
          siteContentUrl,
          patName,
          patSecret: secret,
        });
        let response: Awaited<ReturnType<typeof tableauConnectionsApi.connect>>;
        try {
          response = await tableauConnectionsApi.connect({
            serverUrl,
            siteContentUrl,
            patName,
            storageKind: "os",
            credentialRef,
          });
        } catch (connectError) {
          if (!canCompensateStagedCredential(connectError)) {
            clearPatSecret();
            throw connectError;
          }
          try {
            await deleteNativeCredential(credentialRef);
          } catch {
            throw new Error(
              `${errorMessage(connectError)} The new OS credential could not be removed.`,
            );
          }
          throw connectError;
        }
        await finishCommittedMutation(response, ownerRevision);
        return;
      }

      if (storageKind !== "encrypted" || !fallbackConfirmed) {
        throw new Error(
          "Select the encrypted browser-development fallback before connecting.",
        );
      }
      const response = await tableauConnectionsApi.connect({
        serverUrl,
        siteContentUrl,
        patName,
        patSecret: readPatSecret(),
        storageKind: "encrypted",
        explicitFallback: true,
      });
      await finishCommittedMutation(response, ownerRevision);
    });
  }

  async function activateSaved(): Promise<void> {
    if (!selected) return;
    await runConnectionAction(async (ownerRevision) => {
      const response = await tableauConnectionsApi.activate(selected.id);
      await finishConnection(response.session, selected.id, ownerRevision);
    });
  }

  async function replaceCredential(): Promise<void> {
    if (!selected) return;
    await runConnectionAction(async (ownerRevision) => {
      if (selected.storageKind === "os") {
        if (!capability?.available || !selected.credentialRef) {
          throw new Error(
            capability?.reason ?? "The saved OS credential cannot be replaced.",
          );
        }
        const secret = readPatSecret();
        const { ticket, retirement } = await replaceNativeCredential({
          store: () => storeNativeCredential({
            serverUrl: selected.serverUrl,
            siteContentUrl: selected.siteContentUrl,
            patName,
            patSecret: secret,
          }),
          replace: (credentialRef) => tableauConnectionsApi.replaceCredential(selected.id, { storageKind: "os", credentialRef, patName }),
          discard: deleteNativeCredential,
          clearSecret: clearPatSecret,
          remember: (value, connectionId) => {
            const request = ++retirementGeneration.current;
            setRetirements((pending) => [...pending.filter((item) => item.ticket !== value), { ticket: value, connectionId }]);
            void tableauConnectionsApi.listCredentialRetirements().then((pending) => {
              if (retirementGeneration.current === request) { setRetirements(pending); setRetirementCheckFailed(false); }
            }).catch(() => {
              if (retirementGeneration.current === request) setRetirementCheckFailed(true);
            });
          },
          adopt: (committed) => finishCommittedMutation(committed, ownerRevision),
          retire: async (value) => (await tableauConnectionsApi.retireCredential(value)).status,
        });
        if (ticket && retirement === "removed") {
          retirementGeneration.current++;
          setRetirements((pending) => pending.filter((item) => item.ticket !== ticket));
        } else if (ticket && retirement !== "none") {
          useNotices.getState().show("warning", "The connection was updated, but the previous OS credential could not be removed. Open Connections to retry cleanup.");
        }
        return;
      }

      if (!fallbackConfirmed) {
        throw new Error(
          "Confirm the encrypted browser-development fallback before replacing the credential.",
        );
      }
      const response = await tableauConnectionsApi.replaceCredential(
        selected.id,
        {
          storageKind: "encrypted",
          patSecret: readPatSecret(),
          patName,
          explicitFallback: true,
        },
      );
      setFallbackConfirmed(false);
      await finishCommittedMutation(response, ownerRevision);
    });
  }

  async function retryCredentialCleanup(): Promise<void> {
    await runConnectionAction(async () => {
      const pendingTickets = retirementCheckFailed ? await tableauConnectionsApi.listCredentialRetirements() : retirements;
      if (retirementCheckFailed) { retirementGeneration.current++; setRetirements(pendingTickets); setRetirementCheckFailed(false); }
      let remaining = 0;
      for (const item of pendingTickets) {
        try {
          const result = await tableauConnectionsApi.retireCredential(item.ticket);
          if (result.status === "removed") {
            retirementGeneration.current++;
            setRetirements((pending) => pending.filter((entry) => entry.ticket !== item.ticket));
          } else remaining++;
        } catch { remaining++; }
      }
      if (remaining) throw new Error("Some previous OS credentials could not be removed. Retry cleanup later.");
      useNotices.getState().show("success", "Previous OS credential cleanup completed.");
    });
  }

  async function removeConnection(removeCredential: boolean): Promise<void> {
    if (!selected) return;
    await runConnectionAction(async () => {
      if (selected.storageKind === "os") {
        if (removeCredential) {
          if (!capability?.available || !selected.credentialRef) {
            throw new Error(
              capability?.reason ??
                "The saved OS credential cannot be removed.",
            );
          }
          await deleteNativeCredential(selected.credentialRef);
          try {
            await tableauConnectionsApi.delete(selected.id, "removed");
          } catch (deleteError) {
            throw new Error(
              `The OS credential was removed, but the saved connection remains. ${errorMessage(deleteError)}`,
            );
          }
        } else {
          await tableauConnectionsApi.delete(selected.id, "retained");
        }
      } else {
        await tableauConnectionsApi.delete(selected.id, "database");
      }
      setConfirmDelete(false);
      selectConnection(null);
      await reloadConnections();
      await useConnection.getState().init();
      useNotices
        .getState()
        .show(
          "info",
          "Saved connection removed. Local drafts and publication history are preserved.",
        );
    });
  }

  const canSubmitNew =
    !selected &&
    Boolean(serverUrl && patName && hasPatSecret) &&
    (storageKind === "os" ? Boolean(capability?.available) : fallbackConfirmed);
  const canReplace =
    Boolean(selected && hasPatSecret) &&
    (selected?.storageKind === "os"
      ? Boolean(capability?.available)
      : fallbackConfirmed);

  return (
    <div className="panel connect-panel">
      <div className="panel-header">
        <div className="panel-title">Connect to Tableau</div>
      </div>
      <div className="panel-body">
        <p className="section-hint">
          Use a Personal Access Token from your Tableau Cloud or Server account
          (Account settings &rarr; Personal access tokens).
        </p>
        <fieldset className="connect-grid" disabled={connecting}>
          <label className="full">
            Saved connection
            <select
              value={selectedId}
              disabled={loadingConnections || connecting}
              onChange={(event) => {
                const connection =
                  connections.find((item) => item.id === event.target.value) ??
                  null;
                selectConnection(connection);
              }}
            >
              <option value="">New connection</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label}
                  {connection.isActive ? " (active)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            Tableau server
            <input
              placeholder="https://your-pod.online.tableau.com"
              value={serverUrl}
              disabled={Boolean(selected)}
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </label>
          <label className="full">
            Site content URL
            <input
              placeholder="Leave empty for the default site"
              value={siteContentUrl}
              disabled={Boolean(selected)}
              onChange={(event) => setSiteContentUrl(event.target.value)}
            />
          </label>
          <label>
            PAT name
            <input
              value={patName}
              onChange={(event) => setPatName(event.target.value)}
            />
          </label>
          <label>
            {selected ? "Replacement PAT secret" : "PAT secret"}
            <input
              ref={patSecretRef}
              type="password"
              autoComplete="new-password"
              placeholder={selected ? SAVED_SECRET_PLACEHOLDER : undefined}
              onChange={(event) => setHasPatSecret(Boolean(event.target.value))}
            />
          </label>

          {!selected && capability?.available && capability.actionLabel && (
            <label className="toggle-control full">
              <input
                type="radio"
                name="credential-storage"
                checked={storageKind === "os"}
                onChange={() => setStorageKind("os")}
              />
              {capability.actionLabel}
            </label>
          )}
          {!selected &&
            (browserFallback || (capability && !capability.available)) && (
              <label className="toggle-control full">
                <input
                  type="checkbox"
                  checked={fallbackConfirmed}
                  onChange={(event) => {
                    setFallbackConfirmed(event.target.checked);
                    setStorageKind(event.target.checked ? "encrypted" : "");
                  }}
                />
                {browserFallback
                  ? "Use encrypted browser-development fallback"
                  : "Use encrypted fallback (OS credential storage unavailable)"}
              </label>
            )}
          {!selected &&
            capability &&
            !capability.available &&
            !browserFallback &&
            !fallbackConfirmed && (
              <div className="connect-hint full">
                Enable the encrypted fallback above to proceed without OS
                credential storage.
              </div>
            )}

          {selected?.storageKind === "encrypted" && (
            <label className="toggle-control full">
              <input
                type="checkbox"
                checked={fallbackConfirmed}
                onChange={(event) => setFallbackConfirmed(event.target.checked)}
              />
              Confirm encrypted fallback for credential replacement
            </label>
          )}

          {error && (
            <div className="connect-error full" role="alert">
              {error}
            </div>
          )}

          {(retirementCheckFailed || retirements.length > 0) && <div className="connect-hint full" role="status">
            {retirementCheckFailed ? "Previous credential cleanup could not be checked." : "A previous OS credential still needs cleanup."}
            <button type="button" className="btn small" disabled={connecting} onClick={() => void retryCredentialCleanup()}>Retry credential cleanup</button>
          </div>}

          {!selected && (
            <button
              className="btn primary full"
              disabled={connecting || !canSubmitNew}
              onClick={() => void connectNew()}
            >
              <BusyLabel busy={connecting} idle="Connect and save" active="Connecting..." />
            </button>
          )}

          {selected && (
            <>
              <button
                className="btn primary"
                disabled={connecting}
                onClick={() => void activateSaved()}
              >
                <BusyLabel busy={connecting} idle="Use saved connection" active="Connecting..." />
              </button>
              <button
                className="btn"
                disabled={connecting || !canReplace}
                onClick={() => void replaceCredential()}
              >
                Replace credential
              </button>
              {!confirmDelete && (
                <button
                  className="btn danger full"
                  disabled={connecting}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete saved connection...
                </button>
              )}
              {confirmDelete && selected.storageKind === "os" && (
                <>
                  <div className="section-hint warn full" role="alert">
                    Remove the connection record only, or also remove its OS
                    credential?
                  </div>
                  <button
                    className="btn"
                    disabled={connecting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    disabled={connecting}
                    onClick={() => void removeConnection(false)}
                  >
                    Keep OS credential
                  </button>
                  <button
                    className="btn danger full"
                    disabled={connecting || !capability?.available}
                    onClick={() => void removeConnection(true)}
                  >
                    Delete connection and OS credential
                  </button>
                </>
              )}
              {confirmDelete && selected.storageKind === "encrypted" && (
                <>
                  <div className="section-hint warn full" role="alert">
                    Delete this connection and its encrypted fallback
                    credential?
                  </div>
                  <button
                    className="btn"
                    disabled={connecting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    disabled={connecting}
                    onClick={() => void removeConnection(true)}
                  >
                    Confirm delete
                  </button>
                </>
              )}
            </>
          )}
        </fieldset>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
