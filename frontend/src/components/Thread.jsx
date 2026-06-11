// Thread.jsx — the conversation, as a collapsible panel that floats above the bottom
// composer (the document is the canvas; the chat is a popover over it). Reviewer verdicts
// render inline as their own message kind (ADR: review passes post back into the loop).
import { useEffect, useRef } from "react";

export default function Thread({ log, agentThinking, open, onToggle }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, agentThinking, open]);

  const count = log.length;
  const hasContent = count > 0 || agentThinking;

  // Nothing to show until there's a conversation (the empty canvas has its own prompt).
  if (!hasContent) return null;

  // Collapsed: a slim re-open tab.
  if (!open) {
    return (
      <button className="wi-thread-tab" onClick={onToggle} title="Show conversation">
        <span className="wi-kicker">Conversation</span>
        <span className="wi-thread-tab__n">{count}</span>
        <span aria-hidden="true">⌃</span>
      </button>
    );
  }

  return (
    <div className="wi-thread" role="log" aria-label="Conversation">
      <div className="wi-thread__head">
        <span className="wi-kicker">Conversation</span>
        <button className="wi-thread__close" onClick={onToggle} title="Collapse">⌄</button>
      </div>
      <div className="wi-thread__log" ref={scrollRef}>
        {log.map((m, i) => {
          if (m.role === "event") {
            return <div key={i} className="wi-msg wi-msg--event"><span className="wi-msg__event">{m.text}</span></div>;
          }
          if (m.role === "review") {
            return (
              <div key={i} className="wi-msg wi-msg--review">
                <span className="wi-msg__who">Review</span>
                <span className="wi-msg__text">{m.text}</span>
              </div>
            );
          }
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
    </div>
  );
}
