import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { resolveDatasourceListKey } from '../datasource-picker-actions';
import { metricIsReady } from '../metric-eligibility';

const DATASOURCE_LISTBOX_ID = 'pulse-datasource-options';

export function DatasourcePicker() {
  const datasources = useStore((s) => s.datasources);
  const dsLoading = useStore((s) => s.dsLoading);
  const selectedDs = useStore((s) => s.selectedDs);
  const catalog = useStore((s) => s.catalog);
  const catalogLoadError = useStore((s) => s.catalogLoadError);
  const catalogLoading = useStore((s) => s.catalogLoading);
  const metrics = useStore((s) => s.metrics);
  const slicers = useStore((s) => s.slicers);
  const selectDatasource = useStore((s) => s.selectDatasource);
  const draftSaves = useStore((s) => s.draftSaves);
  const retryDraftSaves = useStore((s) => s.retryDraftSaves);
  const unsaved = Object.values(draftSaves).filter((save) => save.status !== 'saved');
  const failedSaves = unsaved.filter((save) => save.status === 'error');
  const refreshFields = useStore((s) => s.refreshFields);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return datasources.slice(0, 60);
    return datasources
      .filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.projectName.toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [datasources, query]);

  // Keep the active option in range as the filtered list shrinks or grows.
  useEffect(() => {
    setActiveIndex((current) => Math.max(0, Math.min(current, filtered.length - 1)));
  }, [filtered.length]);

  const chooseDatasource = (luid: string) => {
    void selectDatasource(luid);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  const moveActive = (nextIndex: number) => {
    if (filtered.length === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, filtered.length - 1));
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.scrollIntoView({ block: 'nearest' });
  };

  // ---- merged session/source summary ----
  const activeMetrics = Object.values(metrics).filter((m) => m.active).length;
  const ready = Object.values(metrics).filter(
    (m) => catalog && metricIsReady(catalog, m),
  ).length;
  const activeSlicers = Object.values(slicers).filter((s) => s.active).length;
  const fieldCount = catalog
    ? catalog.measures.length + catalog.dimensions.length + catalog.timeDimensions.length
    : 0;

  return (
    <div className="panel" id="datasource-panel">
      <div className="panel-header">
        <span className="panel-kicker">Source</span>
        <div className="panel-title">{selectedDs ? selectedDs.name : 'Datasource'}</div>
        <div className="panel-actions">
          {selectedDs && catalog && (
            <>
              <button className="btn small" onClick={() => void refreshFields()} title="Re-read fields (bypasses cache)">
                Refresh fields
              </button>
              <button
                ref={changeButtonRef}
                className="btn small"
                type="button"
                aria-expanded={open}
                aria-controls="pulse-datasource-options"
                onClick={() => setOpen(true)}
              >
                Change...
              </button>
            </>
          )}
        </div>
      </div>
      <div className="panel-body">
        {catalogLoadError && selectedDs && (
          <div className="warning-banner" role="alert">
            {catalogLoadError} Your saved draft has not been replaced.
            <button className="btn small" onClick={() => void selectDatasource(selectedDs.luid)}>Retry loading datasource</button>
          </div>
        )}
        {unsaved.length > 0 && (
          <div className={failedSaves.length ? 'warning-banner' : 'section-hint'} role={failedSaves.length ? 'alert' : 'status'}>
            {failedSaves.length
              ? `Unsaved changes: ${failedSaves.map((save) => `${save.name}: ${save.error}`).join('; ')}`
              : `Saving changes for ${unsaved.map((save) => save.name).join(', ')}...`}
            {failedSaves.length > 0 && <button className="btn small" onClick={() => void retryDraftSaves()}>Retry saving drafts</button>}
          </div>
        )}
        {!selectedDs || open ? (
          <>
            {selectedDs && open && (
              <div style={{ marginBottom: 10 }}>
                <span className="chip-state amber">switching source</span>
              </div>
            )}
            <label className="sr-only" htmlFor="pulse-datasource-search">Search published datasources</label>
            <input
              id="pulse-datasource-search"
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-controls={DATASOURCE_LISTBOX_ID}
              aria-expanded={!dsLoading}
              aria-activedescendant={filtered[activeIndex] ? `pulse-datasource-option-${activeIndex}` : undefined}
              autoComplete="off"
              placeholder={dsLoading ? 'Loading datasources...' : `Search ${datasources.length} published datasources...`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                const action = resolveDatasourceListKey(event.key, activeIndex, filtered.length);
                if (action.type === 'none') return;
                event.preventDefault();
                if (action.type === 'move') {
                  moveActive(action.index);
                } else {
                  chooseDatasource(filtered[action.index].luid);
                }
              }}
              style={{ width: '100%' }}
              disabled={dsLoading}
              autoFocus={open}
            />
            {!dsLoading && (
              <div
                id={DATASOURCE_LISTBOX_ID}
                className="pulse-datasource-options"
                role="listbox"
                aria-label="Published datasources"
              >
                {filtered.length === 0 && <div className="empty-note">No matching datasources</div>}
                {filtered.map((d, index) => (
                  <div
                    id={`pulse-datasource-option-${index}`}
                    key={d.luid}
                    ref={(node) => { optionRefs.current[index] = node; }}
                    className={`variant-row pulse-datasource-option ${index === activeIndex ? 'active' : ''}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseDatasource(d.luid);
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{d.name}</div>
                      <div className="def-meta">{d.projectName}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {selectedDs && open && (
              <button
                className="btn small"
                style={{ marginTop: 10 }}
                onClick={() => {
                  setOpen(false);
                  window.setTimeout(() => changeButtonRef.current?.focus(), 0);
                }}
              >
                Cancel
              </button>
            )}
          </>
        ) : (
          <>
            <div className="session-kicker" style={{ marginBottom: 4 }}>
              Active Session
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span className="session-sub">
                {selectedDs.projectName || '-'} · {catalog ? catalog.source.toUpperCase() + ' feed' : 'loading...'}
              </span>
            </div>

            {catalogLoading && (
              <div className="waiting-note" style={{ marginTop: 10 }}>Loading field catalog via VDS…</div>
            )}

            {catalog && (
              <div className="stat-row" style={{ marginTop: 14 }}>
                <div className="stat-card">
                  <div className="stat-label">Fields</div>
                  <div className="stat-value">{fieldCount}</div>
                  <div className="stat-sub">{catalog.excluded.length} excluded</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Metrics Ready</div>
                  <div className="stat-value">{ready}</div>
                  <div className="stat-sub">{activeMetrics} selected</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Slicers</div>
                  <div className="stat-value">{activeSlicers}</div>
                  <div className="stat-sub">of {catalog.dimensions.length + catalog.timeDimensions.length} dimensions</div>
                </div>
              </div>
            )}
          </>
        )}

        {catalog && catalog.warnings.map((w, i) => (
          <div key={i} className="warning-banner" style={{ marginTop: 10 }}>{w}</div>
        ))}
      </div>
    </div>
  );
}
