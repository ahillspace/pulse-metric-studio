import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { useActivity } from "./controller";
import { Receipt } from "./Receipt";
import { SelectedReceiptActions } from "./ReceiptActions";
import { BusyLabel } from "../components/ui";
import { Pagination } from "../components/ConfigEditor";
import "./activity.css";

export function Activity() {
  const { receipts, selected, loading, error, undoError, undoReceiptId, readError, readReceiptId, open, load, total, offset, close } = useActivity();
  const [query, setQuery] = useState("");
  const publicationButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!selected && returnFocus.current) {
      publicationButtons.current.get(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [selected]);
  useEffect(() => {
    void load(0, query);
  }, [query, load]);
  return (
    <section className="pulse-history" aria-label="Publication history">
      <div className="pulse-view-toolbar">
        <input type="search" aria-label="Find publication" placeholder="Search publications..."
          value={query} onChange={event => setQuery(event.target.value)} />
        <button className="btn small" disabled={loading} onClick={() => void load()}>
          <BusyLabel busy={loading} idle="Refresh" active="Refreshing..." />
        </button>
      </div>
      {error && !(error === undoError && selected?.id === undoReceiptId) && !(error === readError && selected?.id === readReceiptId) && <p className="warning-banner" role="alert">{error}</p>}
      <SelectedReceiptActions receipt={selected} />
      <div className={`pulse-history-layout${selected ? " has-selection" : ""}`}>
        <div className="pulse-history-index">
          <h2 className="sr-only">Publication history</h2>
          <ul className="pulse-history-list" aria-label="Publications">
            {receipts.map(receipt => (
              <li key={receipt.id}>
                <button className={selected?.id === receipt.id ? "is-selected" : ""}
                  ref={element => { if (element) publicationButtons.current.set(receipt.id, element); else publicationButtons.current.delete(receipt.id); }}
                  aria-label={`Open publication ${receipt.datasourceName}, ${new Date(receipt.createdAt).toLocaleString()}`}
                  aria-current={selected?.id === receipt.id ? "true" : undefined}
                  onClick={() => void open(receipt.id)}>
                  <span className="pulse-history-name">{receipt.datasourceName}</span>
                  <span className="pulse-history-date">{new Date(receipt.createdAt).toLocaleString()}</span>
                  <span className={`pulse-history-outcome${receipt.unknownCount || receipt.failedCount ? " needs-attention" : ""}`}>
                    {receipt.createdCount} created
                    {receipt.failedCount > 0 && `, ${receipt.failedCount} failed`}
                    {receipt.unknownCount > 0 && `, ${receipt.unknownCount} unconfirmed`}
                    {receipt.unattemptedCount > 0 && `, ${receipt.unattemptedCount} not sent`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!receipts.length && !loading && !error && (
            <div className="pulse-history-empty">
              <h3>{query ? "No matching publications" : "No publications yet"}</h3>
              <p>{query ? "Try a different name." : "Published metrics and their results appear here."}</p>
            </div>
          )}
          {loading && !receipts.length && <p role="status" className="pulse-history-empty">Loading publications...</p>}
          {total > 0 && <Pagination page={Math.floor(offset / 20)} size={20} count={total}
            label="Publications" onChange={page => void load(page * 20, query)} />}
        </div>
        {selected && (
          <div className="pulse-history-detail">
            <button className="btn small pulse-history-close" onClick={() => { returnFocus.current = selected.id; close(); }}>Close details</button>
            <Receipt receipt={selected} showActions={false} />
          </div>
        )}
      </div>
    </section>
  );
}
