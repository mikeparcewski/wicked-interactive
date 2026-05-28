// ChatPanel.jsx — conversational panel (ADR-0014), collapsible.
import { useEffect, useRef, useState } from "react";

export default function ChatPanel({ log, onSend, busy, collapsed, onToggle, agentThinking }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);   // local optimistic flag so the input reacts in <16ms
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, collapsed, agentThinking]);

  // Clear "sending" the moment the server echoes our message back (length change is enough).
  useEffect(() => { setSending(false); }, [log.length]);

  if (collapsed) {
    return (
      <aside className="wi-chat wi-chat--collapsed">
        <button className="wi-chat__toggle" title="Open assistant" onClick={onToggle}>
          {agentThinking ? <span className="wi-chat__pulse" /> : "💬"}
        </button>
      </aside>
    );
  }

  function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setSending(true);   // visible feedback on the Send button without waiting for SSE
    onSend(t);
    setText("");
  }

  return (
    <aside className="wi-chat">
      <div className="wi-chat__head">
        <span>Assistant</span>
        <button className="wi-chat__toggle" title="Collapse" onClick={onToggle}>⟨</button>
      </div>
      <div className="wi-chat__log" ref={scrollRef}>
        {log.length === 0 && (
          <p className="wi-chat__hint">Talk to me, or click a block. Try “make the whole page feel more premium”.</p>
        )}
        {log.map((m, i) => (
          <div key={i} className={`wi-msg wi-msg--${m.role}`}>
            {m.role === "event"
              ? <span className="wi-msg__event">{m.text}</span>
              : <><span className="wi-msg__who">{m.role === "user" ? "You" : "Assistant"}</span><span className="wi-msg__text">{m.text}</span></>}
          </div>
        ))}
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
      <form className="wi-chat__input" onSubmit={send}>
        <textarea
          value={text}
          rows={2}
          placeholder="Ask for a change, or guide me… (Enter to send)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(e); }}
        />
        <button type="submit" className="wi-btn wi-btn--primary" disabled={!text.trim() || busy || sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </aside>
  );
}
