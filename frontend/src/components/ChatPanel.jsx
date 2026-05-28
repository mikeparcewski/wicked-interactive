// ChatPanel.jsx — the conversational left panel (ADR-0014). Renders the transcript
// (agent narration + user guidance + edit events) and an input for free-form direction.
import { useEffect, useRef, useState } from "react";

export default function ChatPanel({ log, onSend, busy }) {
  const [text, setText] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <aside className="wi-chat">
      <div className="wi-chat__head">Assistant</div>
      <div className="wi-chat__log" ref={scrollRef}>
        {log.length === 0 && (
          <p className="wi-chat__hint">
            Talk to me here, or click a block in the document. Try “make the whole page feel more premium”.
          </p>
        )}
        {log.map((m, i) => (
          <div key={i} className={`wi-msg wi-msg--${m.role}`}>
            {m.role === "event"
              ? <span className="wi-msg__event">{m.text}</span>
              : <><span className="wi-msg__who">{m.role === "user" ? "You" : "Assistant"}</span><span className="wi-msg__text">{m.text}</span></>}
          </div>
        ))}
      </div>
      <form className="wi-chat__input" onSubmit={send}>
        <textarea
          value={text}
          rows={2}
          placeholder="Ask for a change, or guide me… (Enter to send)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(e); }}
        />
        <button type="submit" className="wi-btn wi-btn--primary" disabled={!text.trim() || busy}>Send</button>
      </form>
    </aside>
  );
}
