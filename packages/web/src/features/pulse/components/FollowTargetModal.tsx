import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FollowTargetOperation } from '../../../api/client';
import {
  buildFollowTargetOperations,
  followTargetMatchesQuery,
  handleFollowTargetSelectionKey,
  reconcileFollowTargetResults,
  resolveCurrentUserFollowTarget,
  targetLabelKey,
  type FollowTargetChoice,
} from '../follow-target-actions';
import type { RegistryActionResults } from '../registry-actions';
import { Modal } from './ui';

type FollowTarget = FollowTargetChoice;

interface FollowTargetSearchKeyEvent {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function consumeFollowTargetSearchEscape(
  event: FollowTargetSearchKeyEvent,
  query: string,
  clearQuery: () => void,
): boolean {
  if (event.key !== 'Escape' || query.length === 0) return false;
  event.preventDefault();
  event.stopPropagation();
  clearQuery();
  return true;
}

interface FollowTargetModalProps {
  metrics: Array<{ id: string; label: string }>;
  currentUserId: string;
  currentUserName?: string;
  onClose: () => void;
  onResults: (results: RegistryActionResults) => void;
  onComplete: () => void;
}

export function FollowTargetModal({
  metrics,
  currentUserId,
  currentUserName,
  onClose,
  onResults,
  onComplete,
}: FollowTargetModalProps) {
  const [targets, setTargets] = useState<FollowTarget[]>([]);
  const [selected, setSelected] = useState<FollowTarget[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'follow' | 'unfollow' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ kind: 'follow' | 'unfollow'; operations: FollowTargetOperation[] } | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const requestSeq = useRef(0);

  // Load the full site inventory ONCE (server-side search is unavailable on
  // this REST API version, so we filter locally). Latest-wins guards the
  // explicit "Refresh targets" reload and StrictMode's double-invoke. The
  // current user is KEPT in the inventory (not filtered out) so their real
  // username shows and stays searchable; the decoration happens at render.
  const loadTargets = async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api.followTargets();
      if (seq !== requestSeq.current) return;
      const next: FollowTarget[] = response.targets
        .map((target) => ({ id: target.id, kind: target.kind, label: target.name ?? target.id }));
      setTargets(next);
      setError(response.errors.length > 0 ? response.errors.join(' ') : null);
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      setTargets([]);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Split out the current-user row (decorated with " (you)" and searchable by
  // their real name) from everyone else, synthesizing the row only when the
  // current user is absent from the fetched inventory.
  const currentUserSplit = useMemo(
    () => resolveCurrentUserFollowTarget(targets, currentUserId, currentUserName),
    [targets, currentUserId, currentUserName],
  );

  // Local, case-insensitive substring filter. The current user is pinned first
  // and always shown while the query is empty (still subject to matching once
  // the user types).
  const filteredTargets = useMemo(() => {
    const matches = (target: FollowTarget) => followTargetMatchesQuery(target, query);
    const selectedKeys = new Set(selected.map(targetKey));
    const { currentUser, others } = currentUserSplit;
    const pinned = currentUser
      && !selectedKeys.has(targetKey(currentUser))
      && matches(currentUser)
      ? [currentUser]
      : [];
    return [
      ...pinned,
      ...others.filter((target) => !selectedKeys.has(targetKey(target)) && matches(target)),
    ];
  }, [selected, currentUserSplit, query]);

  useEffect(() => {
    setActiveIndex((current) => Math.max(0, Math.min(current, filteredTargets.length - 1)));
  }, [filteredTargets.length]);

  const selectTarget = (target: FollowTarget) => {
    setSelected((current) => current.some((entry) => targetKey(entry) === targetKey(target)) ? current : [...current, target]);
    setQuery('');
    setActiveIndex(0);
  };

  const moveActive = (nextIndex: number) => {
    if (filteredTargets.length === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, filteredTargets.length - 1));
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.scrollIntoView({ block: 'nearest' });
  };

  const run = async (kind: 'follow' | 'unfollow', retryOperations?: FollowTargetOperation[]) => {
    if (metrics.length === 0 || (!retryOperations && selected.length === 0) || busy) return;
    setBusy(kind);
    setActionError(null);
    const operations = retryOperations ?? buildFollowTargetOperations(metrics, selected);
    const metricLabels = new Map(metrics.map((metric) => [metric.id, metric.label]));
    const targetLabels = new Map(selected.map((target) => [targetLabelKey(target.kind, target.id), target.label]));
    try {
      const response = kind === 'follow'
        ? await api.follow(operations)
        : await api.unfollow(operations);
      const reconciled = reconcileFollowTargetResults(
        kind,
        operations,
        response.results,
        { metricLabels, targetLabels },
      );
      onResults({
        kind,
        title: kind === 'follow' ? 'Follow results' : 'Unfollow results',
        items: reconciled.items,
        finishedAt: Date.now(),
      });
      onComplete();
      if (reconciled.retryOperations.length > 0) {
        setRetry({ kind, operations: reconciled.retryOperations });
      } else {
        setRetry(null);
        onClose();
      }
    } catch (runError) {
      const detail = runError instanceof Error ? runError.message : String(runError);
      const reconciled = reconcileFollowTargetResults(
        kind,
        operations,
        [],
        { metricLabels, targetLabels },
        detail,
      );
      onResults({
        kind,
        title: kind === 'follow' ? 'Follow results' : 'Unfollow results',
        items: reconciled.items,
        finishedAt: Date.now(),
      });
      setRetry({ kind, operations: reconciled.retryOperations });
      setActionError(detail);
    } finally {
      setBusy(null);
    }
  };

  const listboxId = 'pulse-follow-target-options';
  const activeOptionId = filteredTargets[activeIndex] ? `pulse-follow-target-${activeIndex}` : undefined;

  return (
    <Modal
      title={`Follow or unfollow ${metrics.length} selected metric${metrics.length === 1 ? '' : 's'}`}
      onClose={busy ? undefined : onClose}
      actions={(
        <>
          <button className="btn" type="button" disabled={Boolean(busy)} onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={Boolean(busy) || selected.length === 0} onClick={() => void run('unfollow')}>
            {busy === 'unfollow' ? 'Unfollowing...' : 'Unfollow'}
          </button>
          {retry && (
            <button
              className="btn"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void run(retry.kind, retry.operations)}
            >
              {busy === retry.kind ? 'Retrying...' : `Retry ${retry.operations.length} failed`}
            </button>
          )}
          <button className="btn primary" type="button" disabled={Boolean(busy) || selected.length === 0} onClick={() => void run('follow')}>
            {busy === 'follow' ? 'Following...' : 'Follow'}
          </button>
        </>
      )}
    >
      <div className="pulse-follow-search-row">
        <label htmlFor="pulse-follow-search">Search users or groups</label>
        <div className="pulse-follow-search-control">
          <input
            id="pulse-follow-search"
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            value={query}
            disabled={Boolean(busy)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (consumeFollowTargetSearchEscape(event, query, () => setQuery(''))) {
                return;
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveActive(activeIndex + 1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveActive(activeIndex - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                moveActive(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                moveActive(filteredTargets.length - 1);
              } else if (handleFollowTargetSelectionKey(event, filteredTargets[activeIndex], selectTarget)) {
                return;
              }
            }}
          />
          <button className="btn small" type="button" disabled={Boolean(busy)} onClick={() => void loadTargets()}>
            Refresh targets
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="pulse-target-pills" aria-label="Selected follow targets">
          {selected.map((target) => (
            <span className="pulse-target-pill" key={targetKey(target)}>
              <span>{target.kind === 'GROUP' ? 'Group' : 'User'}: {target.label}</span>
              <button
                type="button"
                aria-label={`Remove ${target.label}`}
                disabled={Boolean(busy)}
                onClick={() => setSelected((current) => current.filter((entry) => targetKey(entry) !== targetKey(target)))}
              >
                Remove
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="pulse-follow-options"
        id={listboxId}
        role="listbox"
        aria-label="Available follow targets"
        aria-multiselectable="true"
        aria-busy={loading}
      >
        {loading && <div className="empty-note" role="status">Loading follow targets...</div>}
        {!loading && filteredTargets.map((target, index) => (
          <div
            id={`pulse-follow-target-${index}`}
            key={targetKey(target)}
            ref={(node) => { optionRefs.current[index] = node; }}
            className={`pulse-follow-option ${index === activeIndex ? 'active' : ''}`}
            role="option"
            aria-selected="false"
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              selectTarget(target);
            }}
          >
            <span>{target.label}</span>
            <span>{target.kind === 'GROUP' ? 'Group' : 'User'}</span>
          </div>
        ))}
        {!loading && filteredTargets.length === 0 && <div className="empty-note">No matching targets.</div>}
      </div>
      {error && <div className="dimension-fork-error" role="alert">Follow target inventory is partial or unavailable: {error}</div>}
      {retry && (
        <div className="warning-banner" role="status">
          {retry.operations.length} metric-target operation{retry.operations.length === 1 ? '' : 's'} failed. Retry runs only those exact pairs.
        </div>
      )}
      {actionError && <div className="dimension-fork-error" role="alert">Follow operation failed: {actionError}</div>}
    </Modal>
  );
}

function targetKey(target: FollowTarget): string {
  return `${target.kind}:${target.id}`;
}
