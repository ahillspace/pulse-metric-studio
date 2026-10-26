import { useEffect, useRef, useState } from "react";
import { activeEditor, contextMatches, useAuthor } from "../author/controller";
import { ProposalReview } from "../author/ProposalReview";
import { useConnection } from "../connections/controller";

const GENERATE_DRAFT_REQUEST =
  "Identify the persona most likely to use this datasource and design a Pulse draft for them, and set the digest audience to that persona. Include the metrics and slicers most useful to that persona, no more than 20 metrics, prioritized by business value, with meaningful names and sensible formats and sentiment. Start each metric name with a single emoji that best represents the metric, followed by a space. Include distinct counts of dimensions only when they provide significant business value. Newly built metrics use month-to-date and over-time data mode, controlled by the app. Do not choose or change their timeframe or data mode. Minimum time granularity defaults to DAY; choose a coarser minimum only when explicitly requested or the measure name or description states that daily data is unavailable. Preserve existing manual settings.";

function elapsedLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function ProposalWaiting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div role="status" className="waiting-note pulse-agent-waiting">
      <span className="spinner" aria-hidden="true" />
      <span>
        Preparing proposed changes... {elapsedLabel(seconds)}
        <small>Big drafts can take a few minutes.</small>
      </span>
    </div>
  );
}

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
        {entry && (
          <button
            className="btn small"
            type="button"
            disabled={entry.proposalBusy || !entry.document.chat.length}
            onClick={() => useAuthor.getState().clearChat()}
          >
            Clear chat
          </button>
        )}
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
        {entry && (
            <div className="pulse-agent-draft">
              <button
                className="btn primary small"
                disabled={!available || entry.proposalBusy}
                onClick={() =>
                  void useAuthor
                    .getState()
                    .requestProposal(
                      GENERATE_DRAFT_REQUEST,
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
          {entry?.proposalBusy && <ProposalWaiting />}
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
            The app sends field metadata, metric settings, and this conversation
            to your AI provider. Local agents can retrieve additional data and
            act through their configured tools. Draft proposals require your
            acceptance; direct tool actions take effect outside app review.
          </p>
        </details>
      </div>
    </div>
  );
}
