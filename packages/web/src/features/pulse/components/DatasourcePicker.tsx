import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeEditor, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import {
  filterDatasourceChoices,
  datasourcePopoverLayout,
  resolveDatasourceListKey,
} from "../datasource-picker-actions";
import { tableauConnectionsApi } from "../../../tableau-connections-api";

export function DatasourcePicker() {
  const { datasources, loadingDatasources, session, checked } = useConnection();
  const entry = useAuthor(activeEditor);
  const drafts = useAuthor((state) => state.drafts);
  const draftTotal = useAuthor((state) => state.draftTotal);
  const draftOffset = useAuthor((state) => state.draftOffset);
  const loadDrafts = useAuthor((state) => state.loadDrafts);
  const [connectionLabels, setConnectionLabels] = useState<
    Record<string, string>
  >({});
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [popoverLayout, setPopoverLayout] = useState<{
    width: number;
    left: number;
  }>();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sources = session
    ? datasources
    : drafts.map((draft) => ({
        luid: draft.context.datasourceLuid,
        name: draft.datasourceName,
        projectName:
          connectionLabels[draft.context.connectionId] ??
          new URL(draft.context.serverUrl).hostname,
        draftId: draft.id,
      }));
  const filtered = useMemo(
    () => filterDatasourceChoices(sources, query),
    [sources, query],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (root.current)
        setPopoverLayout(
          datasourcePopoverLayout(
            window.innerWidth,
            root.current.getBoundingClientRect().left,
          ),
        );
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);
  useEffect(() => {
    let current = true;
    void tableauConnectionsApi
      .list()
      .then((connections) => {
        if (current)
          setConnectionLabels(
            Object.fromEntries(
              connections.map((connection) => [
                connection.id,
                connection.label,
              ]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (!checked || session) return;
    const timer = window.setTimeout(
      () => void loadDrafts(0, query.trim()),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [checked, session, query, loadDrafts]);
  useEffect(() => {
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, filtered.length - 1)),
    );
  }, [filtered.length]);
  useEffect(() => {
    if (open)
      root.current
        ?.querySelector(`#pulse-source-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const choose = (index: number) => {
    const source = filtered[index];
    if (!source) return;
    if ("draftId" in source)
      void useAuthor.getState().openDraft(source.draftId as string);
    else void useAuthor.getState().selectDatasource(source);
    setOpen(false);
    setQuery("");
    input.current?.blur();
  };
  return (
    <div
      className="pulse-datasource-switcher"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span aria-hidden="true" className="pulse-header-separator">
        /
      </span>
      <input
        ref={input}
        role="combobox"
        aria-label="Choose a datasource or search"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="pulse-datasource-options"
        aria-activedescendant={
          open && filtered[activeIndex]
            ? `pulse-source-${activeIndex}`
            : undefined
        }
        placeholder={entry?.record.datasourceName ?? "Select datasource"}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            return;
          }
          const action = resolveDatasourceListKey(
            event.key,
            activeIndex,
            filtered.length,
          );
          if (action.type === "move") {
            event.preventDefault();
            setActiveIndex(action.index);
            setOpen(true);
          } else if (action.type === "select" && open) {
            event.preventDefault();
            choose(action.index);
          }
        }}
      />
      <svg
        className="pulse-source-chevron"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
      >
        <path
          d="m3 4 3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      {open && (
        <div
          id="pulse-datasource-options"
          role="listbox"
          aria-label="Published datasources"
          className="pulse-source-options"
          style={popoverLayout}
        >
          {filtered.map((source, index) => (
            <div
              role="option"
              id={`pulse-source-${index}`}
              key={"draftId" in source ? String(source.draftId) : source.luid}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <strong>{source.name}</strong>
              <span>{source.projectName}</span>
            </div>
          ))}
          {!filtered.length && (
            <p>
              {loadingDatasources
                ? "Loading datasources..."
                : session
                  ? "No matching datasources."
                  : "Connect to Tableau to choose a datasource."}
            </p>
          )}
          {!session && draftTotal > 10 && (
            <div className="pulse-source-pages">
              <button
                className="btn small"
                disabled={draftOffset === 0}
                onClick={() =>
                  void loadDrafts(Math.max(0, draftOffset - 10), query.trim())
                }
              >
                Previous datasources
              </button>
              <button
                className="btn small"
                disabled={draftOffset + drafts.length >= draftTotal}
                onClick={() => void loadDrafts(draftOffset + 10, query.trim())}
              >
                More datasources
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
