import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { metricIsReady } from '../metric-eligibility';
import { validateSelection } from '../lib/payloads';
import { eligibleTimeDimensionIds } from '../field-readiness';
import { Modal, ToggleSwitch } from './ui';

const CEREMONY_STEPS = ['Validating payloads', 'Publishing metrics to Pulse', 'Setting up digest group', 'Subscribing followers'];

// Padlock glyph: closed when locked (assistant cannot change), open when
// unlocked (assistant can change). Inline SVG keeps it crisp at small sizes.
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="11" width="18" height="10" rx="2" />
      {locked ? <path d="M7 11V7a5 5 0 0 1 10 0v4" /> : <path d="M7 11V7a5 5 0 0 1 9.9-1" />}
    </svg>
  );
}

export function PublishSection() {
  const selectedDs = useStore((s) => s.selectedDs);
  const catalog = useStore((s) => s.catalog);
  const metrics = useStore((s) => s.metrics);
  const slicers = useStore((s) => s.slicers);
  const groupFollow = useStore((s) => s.groupFollow);
  const digestAudience = useStore((s) => s.digestAudience);
  const digestAudienceLocked = useStore((s) => s.digestAudienceLocked);
  const publishing = useStore((s) => s.publishing);
  const ceremonyStep = useStore((s) => s.ceremonyStep);
  const lastRun = useStore((s) => s.lastRun);
  const publish = useStore((s) => s.publish);
  const runHistory = useStore((s) => s.runHistory);
  const runHistoryLoading = useStore((s) => s.runHistoryLoading);
  const runHistoryError = useStore((s) => s.runHistoryError);
  const loadRunHistory = useStore((s) => s.loadRunHistory);
  const openRun = useStore((s) => s.openRun);
  const undoBusy = useStore((s) => s.undoBusy);
  const undoRun = useStore((s) => s.undoRun);

  const [confirming, setConfirming] = useState(false);

  const counts = useMemo(() => {
    const m = Object.values(metrics).filter((x) => x.active).length;
    const s = Object.values(slicers).filter((x) => x.active).length;
    const eligibleIds = eligibleTimeDimensionIds({ timeDimensions: catalog?.timeDimensions ?? [] });
    const ready = Object.values(metrics).filter(
      (x) => catalog && metricIsReady(catalog, x),
    ).length;
    const staleTimeFields = Object.values(metrics).filter(
      (x) => x.active && x.timeDimensionFieldId && !eligibleIds.has(x.timeDimensionFieldId),
    ).length;
    return { m, s, ready, staleTimeFields };
  }, [catalog, metrics, slicers]);

  if (!selectedDs) return null;

  // Pulse rejects a definition with no complete metric, and also rejects one
  // with zero adjustable dimensions (validation 400706). Gate the button on
  // both so the user cannot trigger a server-side failure.
  const disabledReason =
    !catalog ? 'Load the datasource and saved draft before publishing.' : validateSelection({ catalog, metrics, slicers })[0]?.message ?? (counts.ready === 0
      ? 'Select at least one complete metric to publish.'
      : counts.s === 0
        ? 'You must select at least one dimension.'
        : undefined);

  return (
    <div className="panel" id="publish-panel">
      <div className="panel-header">
        <span className="panel-kicker">Deploy</span>
        <div className="panel-title">Publish to Pulse</div>
      </div>
      <div className="panel-body">
        <div className="publish-bar">
          <ToggleSwitch
            checked={groupFollow}
            onChange={(v) => {
              useStore.setState({ groupFollow: v });
              useStore.getState().saveDraftDebounced();
            }}
            label="Create/follow a digest group"
          />
          {groupFollow && (
            <>
              <input
                className="audience-input"
                placeholder="Digest audience (e.g. Store Ops)"
                value={digestAudience}
                onChange={(e) => {
                  useStore.setState({ digestAudience: e.target.value });
                  useStore.getState().saveDraftDebounced();
                }}
              />
              <button
                className="btn small icon-only"
                type="button"
                aria-pressed={digestAudienceLocked}
                aria-label={digestAudienceLocked
                  ? 'Locked: the assistant cannot change the digest audience'
                  : 'Unlocked: the assistant can change the digest audience'}
                title={digestAudienceLocked
                  ? 'Locked: the assistant cannot change the digest audience. You can still edit it.'
                  : 'Unlocked: the assistant can change the digest audience.'}
                onClick={() => {
                  useStore.setState({ digestAudienceLocked: !digestAudienceLocked });
                  useStore.getState().saveDraftDebounced();
                }}
              >
                <LockIcon locked={digestAudienceLocked} />
              </button>
              <span className="section-hint">
                {digestAudienceLocked
                  ? 'Assistant changes are blocked.'
                  : 'The assistant can change this value.'}
              </span>
            </>
          )}
          <div style={{ flex: 1 }} />
          <span className="publish-counts">
            {counts.ready} ready metric{counts.ready === 1 ? '' : 's'}
            {counts.m !== counts.ready ? ` (${counts.m} selected, incomplete ones skipped)` : ''} · {counts.s} slicers
          </span>
          {/* WKWebView does not fire the native title tooltip on a disabled
              element, so the reason rides on the wrapper span (which is not
              disabled) to keep the hover hint working. */}
          <span className="publish-create-wrap" title={disabledReason}>
            <button
              className="btn primary"
              disabled={publishing || Boolean(disabledReason)}
              onClick={() => setConfirming(true)}
            >
              Create {counts.ready || ''} metric{counts.ready === 1 ? '' : 's'}
            </button>
          </span>
        </div>
        <details style={{ marginTop: 16 }}>
          <summary>Recent publish runs ({runHistory.length})</summary>
          <p className="section-hint">Open a receipt to review or undo its created resources, including after a refresh.</p>
          <button className="btn small" disabled={runHistoryLoading} onClick={() => void loadRunHistory()}>
            {runHistoryLoading ? 'Loading runs...' : 'Refresh run history'}
          </button>
          {runHistoryError && <p role="alert" className="warning-banner">Run history unavailable: {runHistoryError}</p>}
          {!runHistoryLoading && !runHistoryError && runHistory.length === 0 && <p className="section-hint">No publish runs recorded for this datasource and connection.</p>}
          <ul className="result-list">
            {runHistory.map((run) => (
              <li key={run.runId}>
                <button className="btn small" onClick={() => void openRun(run.runId)}>
                  {new Date(run.createdAt).toLocaleString()} - {run.createdCount} created, {run.failedCount} failed
                </button>
              </li>
            ))}
          </ul>
        </details>
        {counts.staleTimeFields > 0 && (
          <div className="warning-banner" role="alert">
            {counts.staleTimeFields} selected metric{counts.staleTimeFields === 1 ? '' : 's'} use a stale or ineligible time field. Select a current date or datetime field before publishing.
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmModal
          count={counts.ready}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void publish();
          }}
        />
      )}

      {publishing && (
        <Modal title="Creating metrics...">
          {CEREMONY_STEPS.map((step, i) => {
            const currentIdx = CEREMONY_STEPS.indexOf(ceremonyStep);
            const state = currentIdx > i ? 'complete' : currentIdx === i ? 'active' : '';
            return (
              <div key={step} className={`ceremony-step ${state}`}>
                <span className="dot" />
                {step}
              </div>
            );
          })}
        </Modal>
      )}

      {lastRun && !publishing && (
        <ResultModal undoBusy={undoBusy} run={lastRun} onClose={() => useStore.setState({ lastRun: null })} onUndo={() => void undoRun()} />
      )}
    </div>
  );
}

function ConfirmModal({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Ready to publish?"
      onClose={onCancel}
      actions={(
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>Publish now</button>
        </>
      )}
    >
      This creates <strong>{count}</strong> metric definition{count === 1 ? '' : 's'} in Tableau Pulse.
      <p className="section-hint">
        You can undo the whole batch after publishing. The app records the created resources locally across page refreshes.
      </p>
    </Modal>
  );
}

function ResultModal({
  undoBusy,
  run,
  onClose,
  onUndo,
}: {
  undoBusy: boolean;
  run: NonNullable<ReturnType<typeof useStore.getState>['lastRun']>;
  onClose: () => void;
  onUndo: () => void;
}) {
  const refreshReceipt = useStore((state) => state.openRun);
  const successes = run.results.filter((r) => r.status === 'created');
  const failures = run.results.filter((r) => r.status !== 'created');
  const unresolved = successes.filter((item) => item.resolutionStatus === 'failed' || item.resolutionStatus === 'pending');
  const undone = successes.filter((item) => item.undoStatus === 'deleted');
  const undoable = successes.filter((item) => (item.definitionId || item.metricId) && item.undoStatus !== 'deleted');
  const undoAttempted = successes.some((item) => item.undoStatus === 'failed' || item.undoStatus === 'deleted');
  const outcome = undoAttempted
    ? undoable.length > 0 ? undone.length > 0 ? 'mixed' : 'fail' : 'success'
    : failures.length === 0 && unresolved.length === 0 ? 'success' : successes.length === 0 ? 'fail' : 'mixed';
  const allGood = outcome === 'success';
  const followOk = run.followResults?.filter((result) => result.ok).length ?? 0;
  const followBad = run.followResults?.filter((result) => !result.ok).length ?? 0;

  return (
    <Modal
      title={undoAttempted
        ? undoable.length ? `Undo incomplete: ${undone.length} deleted, ${undoable.length} remaining` : `Undo complete: ${undone.length} deleted`
        : `Publish receipt - ${run.createdCount} created, ${run.failedCount} failed`}
      outcome={outcome}
      onClose={undoBusy ? undefined : onClose}
      actions={(
        <>
          <button className="btn danger" disabled={undoBusy || run.publishing || undoable.length === 0} onClick={onUndo}>{undoBusy ? 'Undoing...' : undoable.some((item) => item.undoStatus === 'failed') ? 'Retry undo - delete remaining resources' : "Undo - delete this run's metrics"}</button>
          <button className="btn primary" disabled={undoBusy} onClick={onClose}>Done</button>
        </>
      )}
    >
          {run.publishing && (
            <p className="warning-banner" role="status">
              Publishing is still running. Undo becomes available after publishing finishes.
              <button className="btn small" onClick={() => void refreshReceipt(run.runId)}>Refresh receipt</button>
            </p>
          )}
          {allGood && !run.publishing && undone.length === 0 && (
            <p className="celebrate-line">
              Your metrics are live in Tableau Pulse. They will start appearing in digests on the next cadence.
            </p>
          )}
          {undoAttempted && <p role="status">Original publish receipt: {run.createdCount} created, {run.failedCount} failed.{undoable.length > 0 ? ' Retry undo to delete the remaining resources.' : ''}</p>}
          {unresolved.length > 0 && <p className="warning-banner">{unresolved.length} {unresolved.length === 1 ? 'definition was' : 'definitions were'} created, but the default metric could not be resolved. Review the receipt before publishing again to avoid duplicates.</p>}
          {run.group && (
            <p className="section-hint">
              Group "{run.group.name}" {run.group.existedBefore ? 'reused' : 'created'}
              {followOk > 0 ? ` · subscribed to ${followOk} new metric${followOk === 1 ? '' : 's'}` : ''}
              {run.group.userAddFailed
                ? ' · ⚠ could not add your user to the group'
                : ' · you were added to the group'}
              {'.'}
            </p>
          )}
          {followBad > 0 && (
            <p className="section-hint warn">
              {followBad} metric subscription{followBad === 1 ? '' : 's'} could not be created. The metrics are still live.
            </p>
          )}
          <div className="result-grid">
            <div className="result-col success">
              <h4>Created ({successes.length})</h4>
              <ul className="result-list">
                {successes.map((r) => (
                  <li key={r.itemIndex ?? r.name + (r.definitionId ?? '')}>
                    {r.name}{r.undoStatus === 'deleted' ? ' - deleted' : r.undoStatus === 'failed' ? ' - undo failed; retry available' : ''}
                    {r.definitionId && <div className="section-hint">Definition: {r.definitionId}</div>}
                    {r.undoError && <div className="section-hint">Undo failed: {r.undoError}</div>}
                    {r.error && <div className="section-hint">{r.error}</div>}
                  </li>
                ))}
                {successes.length === 0 && <li className="err">None</li>}
              </ul>
            </div>
            {failures.length > 0 && (
              <div className="result-col fail">
                <h4>Failed ({failures.length})</h4>
                <ul className="result-list">
                  {failures.map((r) => (
                    <li key={r.itemIndex ?? r.name + (r.error ?? '')} className="err">
                      <strong>{r.name}</strong>
                      {r.creationStatus === 'unknown' ? ' - creation outcome unknown; verify in Tableau before retrying' : ''}
                      {r.validationErrors?.length ? ` - ${r.validationErrors.join('; ')}` : r.error ? ` - ${r.error}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
    </Modal>
  );
}
