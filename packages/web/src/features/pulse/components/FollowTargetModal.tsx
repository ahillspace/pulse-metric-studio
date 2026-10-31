import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PulseFollowOperation as FollowTargetOperation } from "@pulse-metric-studio/shared";
import { useRegistry } from "../registry/controller";
import {
  buildFollowTargetOperations,
  existingFollowTargets,
  followTargetMatchesQuery,
  handleFollowTargetSelectionKey,
  mergeFollowTargetChoices,
  resolveCurrentUserFollowTarget,
  type FollowTargetChoice,
} from "../follow-target-actions";
import { registryActionLabel } from "../registry-actions";
import { BusyLabel, Modal } from "./ui";

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
  if (event.key !== "Escape" || query.length === 0) return false;
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
}

export function FollowTargetModal({
  metrics,
  currentUserId,
  currentUserName,
  onClose,
}: FollowTargetModalProps) {
  const results = useRegistry((state) => state.results);
  const [targets, setTargets] = useState<FollowTarget[]>([]);
  const [selected, setSelected] = useState<FollowTarget[]>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"follow" | "unfollow" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addingExisting, setAddingExisting] = useState(false);
  const [existingNotice, setExistingNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<{
    kind: "follow" | "unfollow";
    operations: FollowTargetOperation[];
  } | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const requestSeq = useRef(0);
  const existingRequest = useRef(0);
  const metricScope = JSON.stringify(metrics.map((metric) => metric.id));
  const context = useRegistry((state) => state.context);
  const contextScope = JSON.stringify(context);

  useEffect(() => {
    existingRequest.current += 1;
    setAddingExisting(false);
    setExistingNotice(null);
    return () => { existingRequest.current += 1; };
  }, [metricScope, contextScope]);

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
      const response = await useRegistry.getState().loadTargets();
      if (seq !== requestSeq.current) return;
      const next: FollowTarget[] = response.targets.map((target) => ({
        id: target.id,
        kind: target.kind,
        label: target.name ?? target.id,
      }));
      setTargets(next);
      setSelected((current) => mergeFollowTargetChoices(current, [], next));
      setError(response.errors.length > 0 ? response.errors.join(" ") : null);
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      setTargets([]);
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadTargets();
    return () => {
      requestSeq.current += 1;
    };
  }, []);

  const addExisting = async () => {
    if (busy || addingExisting || loading || metrics.length === 0) return;
    const seq = ++existingRequest.current;
    const scope = JSON.stringify(useRegistry.getState().context);
    const isCurrent = () => seq === existingRequest.current &&
      scope === JSON.stringify(useRegistry.getState().context);
    setAddingExisting(true);
    setExistingNotice(null);
    try {
      const state = await useRegistry.getState().refreshFollowState(
        [...new Set(metrics.map((metric) => metric.id))],
      );
      if (!isCurrent()) return;
      const existing = existingFollowTargets(metrics.map((metric) => metric.id), state);
      setSelected((current) => mergeFollowTargetChoices(current, existing.targets, targets));
      setExistingNotice(existing.incompleteMetricIds.length
        ? `Existing subscriber inventory is partial or unavailable for ${existing.incompleteMetricIds.length} selected metric${existing.incompleteMetricIds.length === 1 ? "" : "s"}. Only confirmed targets were added; some existing subscribers may be missing.${existing.diagnostics.length ? ` ${existing.diagnostics.join(" ")}` : ""}`
        : existing.targets.length
          ? "Existing subscriber targets added. Groups are added as groups, without expanding members."
          : "No existing subscriber targets found for the selected metrics.");
    } catch (error) {
      if (isCurrent()) setExistingNotice(`Existing subscriber inventory is unavailable. Existing selections were kept. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (isCurrent()) setAddingExisting(false);
    }
  };

  // Split out the current-user row (decorated with " (you)" and searchable by
  // their real name) from everyone else, synthesizing the row only when the
  // current user is absent from the fetched inventory.
  const currentUserSplit = useMemo(
    () =>
      resolveCurrentUserFollowTarget(targets, currentUserId, currentUserName),
    [targets, currentUserId, currentUserName],
  );

  // Local, case-insensitive substring filter. The current user is pinned first
  // and always shown while the query is empty (still subject to matching once
  // the user types).
  const filteredTargets = useMemo(() => {
    const matches = (target: FollowTarget) =>
      followTargetMatchesQuery(target, query);
    const selectedKeys = new Set(selected.map(targetKey));
    const { currentUser, others } = currentUserSplit;
    const pinned =
      currentUser &&
      !selectedKeys.has(targetKey(currentUser)) &&
      matches(currentUser)
        ? [currentUser]
        : [];
    return [
      ...pinned,
      ...others.filter(
        (target) => !selectedKeys.has(targetKey(target)) && matches(target),
      ),
    ];
  }, [selected, currentUserSplit, query]);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.max(0, Math.min(current, filteredTargets.length - 1)),
    );
  }, [filteredTargets.length]);

  const selectTarget = (target: FollowTarget) => {
    setSelected((current) =>
      current.some((entry) => targetKey(entry) === targetKey(target))
        ? current
        : [...current, target],
    );
    setQuery("");
    setActiveIndex(0);
  };

  const moveActive = (nextIndex: number) => {
    if (filteredTargets.length === 0) return;
    const bounded = Math.max(
      0,
      Math.min(nextIndex, filteredTargets.length - 1),
    );
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.scrollIntoView({ block: "nearest" });
  };

  const run = async (
    kind: "follow" | "unfollow",
    retryOperations?: FollowTargetOperation[],
  ) => {
    if (!metrics.length || (!retryOperations && !selected.length) || busy || addingExisting)
      return;
    const scope = JSON.stringify(useRegistry.getState().context);
    setBusy(kind);
    setActionError(null);
    const operations =
      retryOperations ?? buildFollowTargetOperations(metrics, selected);
    try {
      const remaining = await useRegistry
        .getState()
        .follow(kind, operations, metrics, selected);
      if (scope !== JSON.stringify(useRegistry.getState().context)) return;
      if (remaining.length) setRetry({ kind, operations: remaining });
      else {
        setRetry(null);
        onClose();
      }
    } catch (error) {
      if (scope === JSON.stringify(useRegistry.getState().context))
        setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (scope === JSON.stringify(useRegistry.getState().context))
        setBusy(null);
    }
  };

  const listboxId = "pulse-follow-target-options";
  const activeOptionId = filteredTargets[activeIndex]
    ? `pulse-follow-target-${activeIndex}`
    : undefined;

  return (
    <Modal
      title={`Follow or unfollow ${metrics.length} selected metric${metrics.length === 1 ? "" : "s"}`}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <button
            className="btn"
            type="button"
            disabled={Boolean(busy)}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            disabled={Boolean(busy) || addingExisting || selected.length === 0}
            onClick={() => void run("unfollow")}
          >
            <BusyLabel busy={busy === "unfollow"} idle="Unfollow" active="Unfollowing..." />
          </button>
          {retry && (
            <button
              className="btn"
              type="button"
              disabled={Boolean(busy) || addingExisting}
              onClick={() => void run(retry.kind, retry.operations)}
            >
              <BusyLabel busy={busy === retry.kind} idle={`Retry ${retry.operations.length} failed`} active="Retrying..." />
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={Boolean(busy) || addingExisting || selected.length === 0}
            onClick={() => void run("follow")}
          >
            <BusyLabel busy={busy === "follow"} idle="Follow" active="Following..." />
          </button>
        </>
      }
    >
      {retry &&
        results &&
        (results.kind === "follow" || results.kind === "unfollow") && (
          <section aria-label="Subscription results">
            <h3>Subscription results</h3>
            <ul className="result-list">
              {results.items.map((item) => (
                <li key={item.key}>
                  <strong>{item.metricLabel}</strong> - {item.targetLabel}:{" "}
                  {registryActionLabel(results.kind, item)}
                  {item.detail ? ` - ${item.detail}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
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
              if (
                consumeFollowTargetSearchEscape(event, query, () =>
                  setQuery(""),
                )
              ) {
                return;
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(activeIndex + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(activeIndex - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveActive(0);
              } else if (event.key === "End") {
                event.preventDefault();
                moveActive(filteredTargets.length - 1);
              } else if (
                handleFollowTargetSelectionKey(
                  event,
                  filteredTargets[activeIndex],
                  selectTarget,
                )
              ) {
                return;
              }
            }}
          />
          <button
            className="btn small"
            type="button"
            disabled={Boolean(busy) || addingExisting}
            onClick={() => void loadTargets()}
          >
            Refresh targets
          </button>
          <button
            className="btn small"
            type="button"
            disabled={Boolean(busy) || addingExisting || loading || metrics.length === 0}
            onClick={() => void addExisting()}
          >
            <BusyLabel busy={addingExisting} idle="Add existing" active="Loading existing..." />
          </button>
        </div>
      </div>

      {existingNotice && <div className="empty-note" role="status">{existingNotice}</div>}

      {selected.length > 0 && (
        <div
          className="pulse-target-pills"
          aria-label="Selected follow targets"
        >
          {selected.map((target) => (
            <span className="pulse-target-pill" key={targetKey(target)}>
              <span>
                {target.kind === "GROUP" ? "Group" : "User"}: {target.label}
              </span>
              <button
                type="button"
                aria-label={`Remove ${target.label}`}
                disabled={Boolean(busy)}
                onClick={() =>
                  setSelected((current) =>
                    current.filter(
                      (entry) => targetKey(entry) !== targetKey(target),
                    ),
                  )
                }
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
        {loading && (
          <div className="empty-note" role="status">
            Loading follow targets...
          </div>
        )}
        {!loading &&
          filteredTargets.map((target, index) => (
            <div
              id={`pulse-follow-target-${index}`}
              key={targetKey(target)}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              className={`pulse-follow-option ${index === activeIndex ? "active" : ""}`}
              role="option"
              aria-selected="false"
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                selectTarget(target);
              }}
            >
              <span>{target.label}</span>
              <span>{target.kind === "GROUP" ? "Group" : "User"}</span>
            </div>
          ))}
        {!loading && filteredTargets.length === 0 && (
          <div className="empty-note">No matching targets.</div>
        )}
      </div>
      {error && (
        <div className="dimension-fork-error" role="alert">
          Follow target inventory is partial or unavailable: {error}
        </div>
      )}
      {retry && (
        <div className="warning-banner" role="status">
          {retry.operations.length} metric-target operation
          {retry.operations.length === 1 ? "" : "s"} failed. Retry runs only
          those exact pairs.
        </div>
      )}
      {actionError && (
        <div className="dimension-fork-error" role="alert">
          Follow operation failed: {actionError}
        </div>
      )}
    </Modal>
  );
}

function targetKey(target: FollowTarget): string {
  return `${target.kind}:${target.id}`;
}
