import { useRegistry } from "./registry/controller";
import { InventoryCounts } from "./registry/InventoryCounts";
import { useEffect, useRef, useState } from "react";
import { subscribeBackendUnavailable } from "../../desktop-lifecycle";
import pulseIcon from "../../assets/pulse-icon.png";
import { DigestSettings } from "./author/DigestSettings";
import { ResizableAssistant } from "./shell/ResizableAssistant";
import { LlmBadge } from "../../components/LlmSettings";
import { ConnectCard } from "./connections/Connect";
import { useConnection } from "./connections/controller";
import { activeEditor, contextMatches, useAuthor } from "./author/controller";
import { WorkingStateNotice } from "./author/WorkingStateNotice";
import { Activity } from "./activity/Activity";
import { useActivity } from "./activity/controller";
import { DatasourcePicker } from "./components/DatasourcePicker";
import { ChatPanel } from "./components/ChatPanel";
import { ConfigEditor } from "./components/ConfigEditor";
import { PublishSection } from "./components/PublishSection";
import { ExistingMetrics } from "./components/ExistingMetrics";
import { useNotices } from "./shell/notifications";
import "./pulse-remediation.css";
import "./workflows.css";
import "./registry/variants.css";

type Area = "Connections" | "Author" | "Registry" | "Activity";
const labels: Record<Area, string> = {
  Connections: "Connections",
  Author: "Author",
  Registry: "Metric Manager",
  Activity: "Activity",
};
function NavIcon({ area }: { area: Area }) {
  const paths: Record<Area, string> = {
    Author: "M4 16V9m6 7V4m6 12V7",
    Registry: "M3 3h5v5H3zm9 0h5v5h-5zM3 12h5v5H3zm9 0h5v5h-5z",
    Activity: "M10 3a7 7 0 1 1-7 7m0-6v4h4m3-2v5l3 2",
    Connections:
      "M7 7 5 9a4 4 0 0 0 6 6l2-2M9 5l2-2a4 4 0 0 1 6 6l-2 2M7 13l6-6",
  };
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[area]} />
    </svg>
  );
}

export default function PulseApp() {
  const [area, setArea] = useState<Area>("Connections");
  const [navigationCollapsed, setNavigationCollapsed] = useState(
    () => window.matchMedia("(max-width: 820px)").matches,
  );
  const [assistantOpen, setAssistantOpen] = useState(
    () => !window.matchMedia("(max-width: 820px)").matches,
  );
  const [backendError, setBackendError] = useState<string | null>(null);
  const { session, checked, error, init, disconnect } = useConnection();
  const entry = useAuthor(activeEditor);
  const notice = useNotices((state) => state.notice);
  useEffect(() => {
    const context = entry && contextMatches(entry.record.context, session) ? entry.record.context : null;
    useRegistry.getState().setContext(context, entry?.record.datasourceName);
    if (context) void useRegistry.getState().ensureLoaded();
  }, [entry?.record.context, entry?.record.datasourceName, session]);
  const initialized = useRef(false);
  const previousSession = useRef(Boolean(session));
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 820px)");
    const resize = () => {
      if (narrow.matches) setAssistantOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        narrow.matches &&
        !document.querySelector('[role="dialog"]')
      )
        setAssistantOpen(false);
    };
    narrow.addEventListener("change", resize);
    window.addEventListener("keydown", escape);
    return () => {
      narrow.removeEventListener("change", resize);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    void init().then(() => useAuthor.getState().loadDrafts());
    void useActivity.getState().load();
  }, [init]);
  useEffect(() => {
    if (checked && !initialized.current) {
      initialized.current = true;
      setArea(session ? "Author" : "Connections");
    } else if (session && !previousSession.current) setArea("Author");
    previousSession.current = Boolean(session);
    if (session) void useAuthor.getState().refreshCatalog();
  }, [session, checked]);
  useEffect(() => {
    const unsubscribeBackend = subscribeBackendUnavailable(setBackendError);
    const expired = () => useConnection.getState().expireSession();
    window.addEventListener("pulse-session-expired", expired);
    return () => {
      window.removeEventListener("pulse-session-expired", expired);
      unsubscribeBackend();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => useNotices.getState().dismiss(),
      4200,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);
  const showActivity = () => {
    setArea("Activity");
    if (entry?.receipt) void useActivity.getState().open(entry.receipt.id);
    void useActivity.getState().load();
  };
  const hasAssistant = area === "Author";
  const hasDatasource = area === "Author" || area === "Registry";
  return (
    <div
      className={`pulse-app pulse-workbench ${navigationCollapsed ? "pulse-nav-collapsed" : ""}`}
    >
      <aside className="pulse-navigation-rail">
        <div className="pulse-workspace-brand">
          <img className="pulse-app-icon" src={pulseIcon} alt="" />
          <strong>Pulse Metric Studio</strong>
        </div>
        <button
          className="pulse-navigation-toggle"
          aria-label={
            navigationCollapsed ? "Expand navigation" : "Collapse navigation"
          }
          aria-expanded={!navigationCollapsed}
          title={
            navigationCollapsed ? "Expand navigation" : "Collapse navigation"
          }
          onClick={() => setNavigationCollapsed((value) => !value)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="14" height="14" rx="2" />
            <path d="M8 3v14" />
          </svg>
        </button>
        <nav aria-label="Pulse workspaces">
          {(["Author", "Registry", "Activity"] as const).map((item) => (
            <button
              key={item}
              aria-label={labels[item]}
              title={labels[item]}
              className={area === item ? "active" : ""}
              aria-current={area === item ? "page" : undefined}
              onClick={() => {
                setArea(item);
                if (item === "Activity") void useActivity.getState().load();
              }}
            >
              <NavIcon area={item} />
              <span>{labels[item]}</span>
            </button>
          ))}
        </nav>
        <div className="pulse-rail-bottom">
          <LlmBadge />
          <button
            className={`pulse-connection-link ${area === "Connections" ? "active" : ""}`}
            aria-label="Connections"
            onClick={() => setArea("Connections")}
          >
            <NavIcon area="Connections" />
            <span>
              Connections
              <small>
                {session
                  ? session.siteContentUrl || "Default site"
                  : "Not connected"}
              </small>
            </span>
            <span className={`status-dot ${session ? "on" : "off"}`} />
          </button>
          {session && (
            <button
              className="pulse-disconnect"
              onClick={() => {
                void disconnect();
                setArea("Connections");
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </aside>
      <div className="pulse-workspace">
        <header className="pulse-location-header">
          <h1><NavIcon area={area} />{labels[area]}</h1>
          {hasDatasource && <DatasourcePicker />}
          {area === "Author" && <InventoryCounts />}
          <div id="pulse-header-actions" />
          {hasAssistant && (
            <button
              className={`btn pulse-assistant-button ${assistantOpen ? "active" : ""}`}
              aria-expanded={assistantOpen}
              aria-controls="pulse-assistant"
              aria-label={assistantOpen ? "Collapse agent" : "Expand agent"}
              onClick={() => setAssistantOpen((value) => !value)}
            >
              Assistant
            </button>
          )}
        </header>
        {backendError && (
          <div className="warning-banner" role="alert">
            {backendError}
          </div>
        )}
        {error && area !== "Connections" && (
          <div className="warning-banner" role="alert">
            {error}
            <button className="btn small" onClick={() => void init()}>
              Retry connection status
            </button>
          </div>
        )}
        {!checked && (
          <p className="pulse-starting" role="status">
            Checking connection...
          </p>
        )}
        <div className="pulse-workspace-content">
          <main className="pulse-main" aria-label={`${labels[area]} workspace`}>
            <fieldset
              disabled={Boolean(backendError)}
              className="pulse-workspace-fields"
            >
              <div hidden={area !== "Connections"}>
                <ConnectCard />
              </div>
              <div hidden={area !== "Author"}>
                <WorkingStateNotice />
                <DigestSettings />
                <ConfigEditor />
                <PublishSection
                  onActivity={showActivity}
                  visible={area === "Author" && !backendError}
                />
                {!entry && (
                  <div className="pulse-empty-state">
                    <h2>Choose a datasource</h2>
                    <p>Choose a published datasource to begin.</p>
                  </div>
                )}
              </div>
              <div hidden={area !== "Registry"}>
                <ExistingMetrics visible={area === "Registry"} />
              </div>
              <div hidden={area !== "Activity"}>
                <Activity />
              </div>
            </fieldset>
          </main>
          <ResizableAssistant open={hasAssistant && assistantOpen}>
            <fieldset
              disabled={Boolean(backendError)}
              className="pulse-workspace-fields"
            >
              <ChatPanel collapsed={!hasAssistant || !assistantOpen} />
            </fieldset>
          </ResizableAssistant>
        </div>
      </div>
      {notice && (
        <div className="toast-host">
          <div
            className={`toast ${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.message}
            <button
              className="btn small"
              aria-label="Dismiss notification"
              onClick={() => useNotices.getState().dismiss()}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
