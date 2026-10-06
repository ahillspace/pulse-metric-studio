import { useEffect, useRef } from "react";
import { activeEditor, contextMatches, useAuthor } from "../author/controller";
import { ProposalReview } from "../author/ProposalReview";
import { useConnection } from "../connections/controller";

export function ChatPanel({ collapsed = false }: { collapsed?: boolean }) {
  const entry = useAuthor(activeEditor);
  const session = useConnection((state) => state.session);
  const transcript = useRef<HTMLDivElement>(null);
  const available = Boolean(
    entry && contextMatches(entry.record.context, session),
  );
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entry?.proposal, entry?.document.chat, collapsed]);
  return (
    <div className="pulse-agent-panel" id="assistant-panel">
      <div className="pulse-agent-heading">
        <h2 className="panel-title">Metric assistant</h2>
      </div>
      <div className="pulse-agent-body">
        {!entry && (
          <p className="empty-note">
            Choose a datasource to start a conversation.
          </p>
        )}
        {entry && !available && (
          <p className="section-hint">
            Connect to Tableau to request suggestions.
          </p>
        )}
        {entry &&
          !entry.document.chat.some(
            (message) => message.role === "assistant",
          ) &&
          !entry.proposal && (
            <div className="pulse-agent-draft">
              <button
                className="btn primary small"
                disabled={!available || entry.proposalBusy}
                onClick={() =>
                  void useAuthor
                    .getState()
                    .requestProposal(
                      "Design Pulse metrics for a business audience. Include all metrics and slicers that provide end-user business value, with meaningful names and sensible formats and sentiment. Start each metric name with a single emoji that best represents the metric, followed by a space. Include distinct counts of dimensions only when they provide significant business value. Newly built metrics use month-to-date and over-time data mode, controlled by the app. Do not choose or change their timeframe or data mode. Minimum time granularity defaults to DAY; choose a coarser minimum only when explicitly requested or the measure name or description states that daily data is unavailable. Preserve existing manual settings.",
                    )
                }
              >
                Generate draft
              </button>
            </div>
          )}
        <div
          className="chat-transcript"
          ref={transcript}
          role="log"
          aria-label="Metric assistant conversation"
          aria-live="polite"
        >
          {entry?.document.chat.map((message, index) => (
            <div
              className={`chat-bubble ${message.role}`}
              key={`${message.ts}-${index}`}
            >
              {message.content}
            </div>
          ))}
          {entry?.proposalBusy && (
            <div role="status" className="waiting-note">
              Preparing proposed changes...
            </div>
          )}
          {entry?.proposalError && (
            <div role="alert" className="warning-banner">
              {entry.proposalError}
            </div>
          )}
          {entry?.proposalNotice && (
            <p className="section-hint" role="status">
              {entry.proposalNotice}
            </p>
          )}
          {entry?.proposal && <ProposalReview entry={entry} />}
        </div>
        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (entry?.composer.trim())
              void useAuthor.getState().requestProposal(entry.composer.trim());
          }}
        >
          <textarea
            aria-label="Message metric assistant"
            rows={3}
            placeholder="Describe a change to review..."
            value={entry?.composer ?? ""}
            disabled={!available}
            onChange={(event) =>
              useAuthor.getState().setComposer(event.target.value)
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            className="btn primary"
            type="submit"
            disabled={
              !available || entry?.proposalBusy || !entry?.composer.trim()
            }
          >
            Send
          </button>
        </form>
        <details className="pulse-assistant-disclosure">
          <summary>About this assistant</summary>
          <p>
            Your AI provider receives field metadata, metric settings, and this
            conversation. Row data and credentials are not included. Proposed
            changes require your acceptance.
          </p>
        </details>
      </div>
    </div>
  );
}
