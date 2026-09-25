import { useMemo } from 'react';
import {
  MIN_GRANULARITY_OPTIONS,
  type MetricSelection,
} from '@pulse-metric-studio/shared';
import { useStore } from '../../../store';
import { emptyTimeDimensionDiagnostic, eligibleTimeDimensionIds } from '../field-readiness';
import { currentCatalogField, metricEligibilityIssue } from '../metric-eligibility';
import { validateSelection } from '../lib/payloads';
import { ToggleSwitch } from './ui';

const IDENTIFIER_RE = /(^|_)(id|uuid|guid|key|email|phone)($|_)|email/i;

export function ConfigEditor() {
  const catalog = useStore((s) => s.catalog);
  const metrics = useStore((s) => s.metrics);
  const slicers = useStore((s) => s.slicers);
  const hideUnused = useStore((s) => s.hideUnused);

  if (!catalog) return null;

  const activeMetrics = Object.values(metrics).filter((m) => m.active);
  const activeSlicers = Object.values(slicers).filter((s) => s.active);
  const issues = activeMetrics.length > 0 ? validateSelection({ catalog, metrics, slicers }) : [];
  const activeIds = new Set([...activeMetrics.map((m) => m.fieldId), ...activeSlicers.map((s) => s.fieldId)]);

  return (
    <div className="panel" id="matrix-panel">
      <div className="panel-header">
        <span className="panel-kicker">Config</span>
        <div className="panel-title">Metric Matrix</div>
        <div className="panel-actions">
          <span className="publish-counts">
            Slicers: {activeSlicers.length} · Metrics: {activeMetrics.length}
          </span>
          <ToggleSwitch
            checked={hideUnused}
            onChange={() => useStore.setState({ hideUnused: !hideUnused })}
            label="Hide unused"
          />
          <button
            className="btn small"
            disabled={activeIds.size === 0}
            onClick={() => {
              if (window.confirm('Clear the whole configuration (metrics, slicers and chat)?')) {
                useStore.getState().clearAll();
              }
            }}
          >
            Clear all
          </button>
        </div>
      </div>
      <div className="panel-body">
        {issues.length > 0 && <div className="warning-banner" role="alert">{issues.map((issue, index) => <div key={`${issue.field}-${index}`}>{issue.message}</div>)}</div>}
        <SlicersSubpanel catalog={catalog} hideUnused={hideUnused} activeIds={activeIds} />
        <MetricsSubpanel catalog={catalog} metrics={metrics} hideUnused={hideUnused} activeIds={activeIds} />
      </div>
    </div>
  );
}

function SlicersSubpanel({
  catalog,
  hideUnused,
  activeIds,
}: {
  catalog: NonNullable<ReturnType<typeof useStore.getState>['catalog']>;
  hideUnused: boolean;
  activeIds: Set<string>;
}) {
  const slicers = useStore((s) => s.slicers);
  const toggleSlicer = useStore((s) => s.toggleSlicer);

  const visible = useMemo(() => {
    const all = [...catalog.dimensions];
    for (const slicer of Object.values(slicers)) {
      if (all.some((field) => field.id === slicer.fieldId)) continue;
      const field = currentCatalogField(catalog, slicer.fieldId);
      if (field) all.push(field);
    }
    return hideUnused ? all.filter((f) => activeIds.has(f.id)) : all;
  }, [catalog, slicers, hideUnused, activeIds]);

  return (
    <>
      <div className="subpanel-title">Slicers - dimensions available to every metric</div>
      <div className="pill-wrap">
        {visible.map((f) => {
          const isActive = Boolean(slicers[f.id]?.active);
          return (
            <button
              key={f.id}
              className={`pill ${isActive ? 'active' : 'inactive'} ${IDENTIFIER_RE.test(f.name) ? 'warn' : ''}`}
              onClick={() => toggleSlicer(f.id)}
              title={f.table ? `${f.table} · ${f.dataType}` : f.dataType}
            >
              {f.label}
            </button>
          );
        })}
      </div>
      {Object.values(slicers).filter((slicer) => slicer.active && !currentCatalogField(catalog, slicer.fieldId)).map((slicer) => (
        <button key={slicer.fieldId} className="pill warn" onClick={() => toggleSlicer(slicer.fieldId)}>Remove unavailable slicer: {slicer.fieldLabel}</button>
      ))}
      {visible.length === 0 && <div className="empty-note">No dimension fields in this datasource.</div>}
    </>
  );
}

function MetricsSubpanel({
  catalog,
  metrics,
  hideUnused,
  activeIds,
}: {
  catalog: NonNullable<ReturnType<typeof useStore.getState>['catalog']>;
  metrics: Record<string, MetricSelection>;
  hideUnused: boolean;
  activeIds: Set<string>;
}) {
  const toggleMetric = useStore((s) => s.toggleMetric);
  const updateMetric = useStore((s) => s.updateMetric);
  const timeFields = catalog.timeDimensions;
  const hasTimeFields = timeFields.length > 0;
  const eligibleTimeIds = eligibleTimeDimensionIds(catalog);

  const rows = useMemo(() => {
    const fields = new Map(catalog.measures.map((field) => [field.id, field]));
    for (const selection of Object.values(metrics)) {
      if (!fields.has(selection.fieldId)) {
        const field = currentCatalogField(catalog, selection.fieldId);
        if (field) fields.set(field.id, field);
      }
    }
    const ids = new Set([...fields.keys(), ...Object.keys(metrics)]);
    return [...ids]
      .filter((id) => !hideUnused || activeIds.has(id))
      .map((fieldId) => ({ fieldId, field: currentCatalogField(catalog, fieldId), sel: metrics[fieldId] }));
  }, [catalog, metrics, hideUnused, activeIds]);

  return (
    <>
      <div className="subpanel-title">Metrics - review every selected field</div>
      {!hasTimeFields && (
        <div className="warning-banner" role="alert">
          {emptyTimeDimensionDiagnostic(catalog)}
        </div>
      )}
      <table className="metrics-table">
        <colgroup>
          <col style={{ width: '17%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '6%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Field</th>
            <th>Time field</th>
            <th>Agg</th>
            <th>Cumul</th>
            <th>Data</th>
            <th>Fmt</th>
            <th>Senti</th>
            <th>Metric name</th>
            <th>Description</th>
            <th>Min grain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ fieldId, field, sel }) => {
            if (!field) return (
              <tr key={fieldId} className={sel?.active ? '' : 'inactive'}>
                <td><button className="field-toggle" onClick={() => toggleMetric(fieldId)}>{sel?.active ? 'Remove ' : 'Restore '}{sel?.fieldLabel ?? fieldId}</button></td>
                <td colSpan={9}>{sel ? metricEligibilityIssue(catalog, sel) : 'Field unavailable. Refresh the catalog.'}</td>
              </tr>
            );
            const issue = sel?.active ? metricEligibilityIssue(catalog, sel) : undefined;
            const isMeasure = catalog.measures.some((measure) => measure.id === field.id);
            const active = Boolean(sel?.active);
            const staleTimeField = Boolean(
              sel?.timeDimensionFieldId && !eligibleTimeIds.has(sel.timeDimensionFieldId),
            );
            return (
              <tr
                key={field.id}
                className={`${active ? '' : 'inactive'}`}
              >
                <td title={field.formula ? `${field.label}\n${field.formula}` : field.label}>
                  <button className="field-toggle" onClick={() => toggleMetric(field.id)}>
                    {active ? '✓ ' : ''}
                    {field.label}
                    {field.requiresUserAgg && <span className="lock-badge">AGG</span>}
                  </button>
                  {issue && <div className="section-hint">{issue}</div>}
                </td>
                <td>
                  {active ? (
                    <select
                      value={sel?.timeDimensionFieldId ?? ''}
                      aria-invalid={staleTimeField || undefined}
                      title={staleTimeField ? 'This saved time field is no longer an eligible date or datetime field.' : undefined}
                      onChange={(e) =>
                        updateMetric(field.id, {
                          timeDimensionFieldId: e.target.value || null,
                        })
                      }
                      disabled={!hasTimeFields}
                    >
                      <option value="">- none -</option>
                      {staleTimeField && sel?.timeDimensionFieldId && (
                        <option value={sel.timeDimensionFieldId}>Stale field - select another</option>
                      )}
                      {timeFields.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </td>
                <td>
                  {active ? (
                    field.requiresUserAgg ? (
                      <input value="USER" disabled title="Aggregate calculation - publishes as AGGREGATION_USER" />
                    ) : (
                      <select
                        value={sel?.aggregation ?? 'SUM'}
                        onChange={(e) =>
                          updateMetric(field.id, { aggregation: e.target.value as MetricSelection['aggregation'] })
                        }
                      >
                        {!isMeasure && sel?.aggregation !== 'COUNT_DISTINCT' && <option value={sel?.aggregation} disabled>{sel?.aggregation} (unsupported)</option>}
                        {isMeasure && <><option>SUM</option><option>AVERAGE</option><option>MIN</option><option>MAX</option></>}
                        <option>COUNT_DISTINCT</option>
                      </select>
                    )
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <ToggleSwitch
                      checked={!field.requiresUserAgg && Boolean(sel?.cumulative)}
                      label=""
                      disabled={
                        field.requiresUserAgg ||
                        sel?.temporality === 'LATEST' ||
                        sel?.aggregation !== 'SUM' ||
                        sel?.format === 'PERCENT'
                      }
                      title={field.requiresUserAgg
                        ? 'User-aggregated measures cannot be cumulative'
                        : sel?.temporality === 'LATEST' ? 'Running totals are invalid for point-in-time metrics' : undefined}
                      onChange={(v) => updateMetric(field.id, { cumulative: v })}
                    />
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <select
                      value={sel?.temporality ?? 'OVER_TIME'}
                      onChange={(e) => {
                        const temporality = e.target.value as MetricSelection['temporality'];
                        updateMetric(field.id, {
                          temporality,
                          // pod constraint: running totals conflict with point-in-time
                          ...(temporality === 'LATEST' ? { cumulative: false } : {}),
                        });
                      }}
                      title="Over time = flowing time series; Latest = most recent snapshot value per entity"
                    >
                      <option value="OVER_TIME">Over time</option>
                      <option value="LATEST">Latest</option>
                    </select>
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <select
                      value={sel?.format ?? 'NUMBER'}
                      onChange={(e) =>
                        updateMetric(field.id, { format: e.target.value as MetricSelection['format'] })
                      }
                    >
                      <option>NUMBER</option>
                      <option>CURRENCY</option>
                      <option>PERCENT</option>
                    </select>
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <select
                      value={sel?.sentiment ?? 'NONE'}
                      onChange={(e) =>
                        updateMetric(field.id, { sentiment: e.target.value as MetricSelection['sentiment'] })
                      }
                    >
                      <option>UP</option>
                      <option>DOWN</option>
                      <option>NONE</option>
                    </select>
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <input
                      value={sel?.name ?? ''}
                      onChange={(e) => updateMetric(field.id, { name: e.target.value })}
                    />
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <input
                      value={sel?.description ?? ''}
                      placeholder="What this metric means"
                      onChange={(e) => updateMetric(field.id, { description: e.target.value })}
                    />
                  ) : null}
                </td>
                <td>
                  {active ? (
                    <select
                      value={sel?.minGranularity ?? ''}
                      onChange={(e) =>
                        updateMetric(field.id, {
                          minGranularity: e.target.value as MetricSelection['minGranularity'],
                        })
                      }
                    >
                      {MIN_GRANULARITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-note">No measures found in this datasource.</div>}
    </>
  );
}
