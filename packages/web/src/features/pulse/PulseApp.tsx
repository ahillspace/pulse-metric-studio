import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { TopBar, ConnectCard } from '../../components/Connect';
import { DatasourcePicker } from './components/DatasourcePicker';
import { ChatPanel } from './components/ChatPanel';
import { ConfigEditor } from './components/ConfigEditor';
import { PublishSection } from './components/PublishSection';
import { ExistingMetrics } from './components/ExistingMetrics';
import { WorkbenchFrame } from '../../components/workbench';
import './pulse-remediation.css';

function Sidebar() {
  const connected = useStore((s) => s.connected);
  const selectedDs = useStore((s) => s.selectedDs);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar pulse-agent-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Pulse metric agent">
      <button
        className="pulse-agent-toggle"
        type="button"
        aria-expanded={!collapsed}
        aria-controls="pulse-agent-content"
        aria-label={collapsed ? 'Expand agent' : 'Collapse agent'}
        title={collapsed ? 'Expand agent' : 'Collapse agent'}
        onClick={() => setCollapsed((value) => !value)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 4v16" stroke="currentColor" strokeWidth="1.5" />
          <path d={collapsed ? 'm13 9 3 3-3 3' : 'm17 9-3 3 3 3'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id="pulse-agent-content" className="pulse-agent-content" hidden={collapsed}>
        <div className="brand-block">
          <div className="brand-mark">
            <span className="brand-glyph">
              <svg width="20" height="20" viewBox="0 0 64 64" fill="none">
                <polyline points="6,38 18,38 23,27 29,45 35,31 42,31" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M 42 31 C 46 31 48 26 50.5 22" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
                <circle cx="52.5" cy="20" r="4.6" fill="#6fb3ff" />
              </svg>
            </span>
            <div>
              <div className="brand-name">Pulse Metric Studio</div>
            </div>
          </div>
          <div className="brand-sub">ahillspace // v0.1</div>
        </div>

        <ChatPanel collapsed={collapsed} />

        <div className="sidebar-foot">
          <span className={`status-dot ${connected ? 'on' : 'off'}`} />
          <span>{connected ? (selectedDs?.name ?? 'connected') : 'offline'}</span>
        </div>
      </div>
    </aside>
  );
}

export default function App() {
  const connected = useStore((s) => s.connected);
  const statusChecked = useStore((s) => s.statusChecked);
  const init = useStore((s) => s.init);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useStore.setState({ toast: null }), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!statusChecked) {
    return (
      <div className="app-shell">
        <TopBar />
        <div className="main-col"><div className="empty-note">Starting up…</div></div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="app-shell">
        <TopBar />
        <div className="connect-wrap"><ConnectCard /></div>
      </div>
    );
  }

  return (
    <WorkbenchFrame topbar={<TopBar />} sidebar={<Sidebar />}>
      <DatasourcePicker />
      <PublishSection />
      <ConfigEditor />
      <ExistingMetrics />
      {toast && (
        <div className="toast-host">
          <div className={`toast ${toast.tone}`}>{toast.message}</div>
        </div>
      )}
    </WorkbenchFrame>
  );
}
