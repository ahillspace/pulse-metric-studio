import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';

const REFINEMENTS = [
  'Add two more useful measures as metrics with business names.',
  'Trim the metric set to the four most decision-useful metrics.',
  'Add the most meaningful slicers for a leadership audience.',
  'Remove noisy or identifier-like slicers.',
];

const WAITING_MESSAGES = [
  'Reading the field catalog…',
  'Designing the metric set…',
  'Choosing sensible aggregations…',
  'Almost there…',
];

export function ChatPanel({ collapsed = false }: { collapsed?: boolean }) {
  const catalog = useStore((s) => s.catalog);
  const chat = useStore((s) => s.chat);
  const chatBusy = useStore((s) => s.chatBusy);
  const hasGeneratedDraft = useStore((s) => s.hasGeneratedDraft);
  const sendChat = useStore((s) => s.sendChat);

  const [text, setText] = useState('');
  const [waitIdx, setWaitIdx] = useState(0);

  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chatBusy) {
      setWaitIdx(0);
      return;
    }
    const timer = setInterval(() => setWaitIdx((i) => (i + 1) % WAITING_MESSAGES.length), 2500);
    return () => clearInterval(timer);
  }, [chatBusy]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [chat, chatBusy, collapsed]);

  return (
    <div className="pulse-agent-panel" id="assistant-panel">
      <div className="pulse-agent-heading">
        <h2 className="panel-title">Metric assistant</h2>
        <p>Design and refine your Pulse metrics.</p>
      </div>
      <div className="pulse-agent-body">
        <div className="pulse-agent-draft">
          {catalog && !hasGeneratedDraft && !chatBusy && (
            <button
              className="btn primary small"
              onClick={() =>
                void sendChat(
                  'Design an initial Pulse metric set for this datasource for a business audience: pick focused measures, good names, sensible formats and sentiment, and a few useful slicers.',
                  { isDraft: true },
                )
              }
            >
              ✦ Generate draft
            </button>
          )}
        </div>
        <div className="chat-transcript" ref={transcriptRef} role="log" aria-label="Metric assistant conversation" aria-live="polite">
          {chat.length === 0 && !chatBusy && (
            <div className="empty-note">
              {catalog
                ? 'Describe your audience and the questions they need answered, or select Generate draft.'
                : 'Select a datasource to start designing Pulse metrics with your assistant.'}
            </div>
          )}
          {chat.map((m) => (
            <div key={m.id} className={`chat-bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {chatBusy && <div className="waiting-note chat-bubble assistant" role="status">{WAITING_MESSAGES[waitIdx]}</div>}
        </div>
        {catalog && hasGeneratedDraft && (
          <div className="chip-row">
            {REFINEMENTS.map((r) => (
              <button key={r} className="chip" disabled={chatBusy} onClick={() => void sendChat(r)}>
                {shortLabel(r)}
              </button>
            ))}
          </div>
        )}
        <form
          className="chat-compose"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t || chatBusy || !catalog) return;
            setText('');
            void sendChat(t);
          }}
        >
          <textarea
            aria-label="Message metric assistant"
            rows={3}
            placeholder="Ask for metrics or describe a change..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={chatBusy || !catalog}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button className="btn primary" type="submit" disabled={chatBusy || !catalog || !text.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function shortLabel(r: string): string {
  if (r.startsWith('Add two more')) return '+ measures';
  if (r.startsWith('Trim')) return '− trim to essentials';
  if (r.startsWith('Add the most')) return '+ slicers';
  return '− clean slicers';
}
