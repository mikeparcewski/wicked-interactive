// Thread.jsx — the conversation, as a panel that floats above the bottom composer and doubles
// as the live "agent at work" surface (ADR-0024). While the agent is working it force-opens,
// can't be collapsed, and the canvas behind it is blurred; the agent's question renders as
// inputs (you can also just type your answer in the composer below). Reviewer verdicts render
// inline. When a new render lands it flips to "Ready" and you close it to view the document.
import { useEffect, useRef } from "react";

export default function Thread({ log, agentThinking, open, forceOpen, lockOpen, question, onAnswer, renderReady, onClose, onToggle }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, agentThinking, open, forceOpen, question]);

  const count = log.length;
  const hasContent = count > 0 || agentThinking || !!question || forceOpen;
  if (!hasContent) return null;

  const isOpen = forceOpen || open;
  if (!isOpen) {
    return (
      <button className="wi-thread-tab" onClick={onToggle} title="Show conversation">
        <span className="wi-kicker">Conversation</span>
        <span className="wi-thread-tab__n">{count}</span>
        <span aria-hidden="true">⌃</span>
      </button>
    );
  }

  const title = renderReady ? "Ready — your new version is in" : lockOpen ? "Working on it…" : "Conversation";

  return (
    <div className={`wi-thread${renderReady ? " wi-thread--ready" : ""}${lockOpen ? " wi-thread--working" : ""}`} role="log" aria-label="Conversation">
      <div className="wi-thread__head">
        {lockOpen && <span className="wi-spinner wi-thread__spin" aria-hidden="true" />}
        {renderReady && <span className="wi-thread__tick" aria-hidden="true">✓</span>}
        <span className="wi-kicker">{title}</span>
        <button
          className="wi-thread__close"
          onClick={renderReady ? onClose : onToggle}
          disabled={lockOpen}
          title={lockOpen ? "Working — hang on…" : renderReady ? "Done — close and view the document" : "Collapse"}
        >{renderReady ? "✕" : "⌄"}</button>
      </div>

      <div className="wi-thread__log" ref={scrollRef}>
        {log.map((m, i) => {
          if (m.role === "event") return <div key={i} className="wi-msg wi-msg--event"><span className="wi-msg__event">{m.text}</span></div>;
          if (m.role === "review") return <div key={i} className="wi-msg wi-msg--review"><span className="wi-msg__who">Review</span><span className="wi-msg__text">{m.text}</span></div>;
          return (
            <div key={i} className={`wi-msg wi-msg--${m.role}`}>
              <span className="wi-msg__who">{m.role === "user" ? "You" : "Assistant"}</span>
              <span className="wi-msg__text">{m.text}</span>
            </div>
          );
        })}
        {agentThinking && (
          <div className="wi-msg wi-msg--agent wi-msg--thinking" aria-live="polite">
            <span className="wi-msg__who">Assistant</span>
            <span className="wi-msg__text">
              <span className="wi-typing"><span></span><span></span><span></span></span>
              <span className="wi-typing__label">working on it…</span>
            </span>
          </div>
        )}
      </div>

      {question && (
        <div className="wi-thread__q">
          <p className="wi-thread__qtext">{question.text}</p>
          {(question.options || []).length > 0 && (
            <div className="wi-thread__opts">
              {question.options.map((o) => (
                <button key={o} className="wi-btn wi-btn--primary" onClick={() => onAnswer(o)}>{o}</button>
              ))}
            </div>
          )}
          <p className="wi-thread__qhint">…or type your own answer in the box below.</p>
        </div>
      )}
    </div>
  );
}
