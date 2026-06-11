// AgentConsole.jsx — the live "agent at work" modal (ADR-0024). Replaces the bare processing
// lock: it streams what the agent is doing as events arrive, renders any clarifying question as
// inputs, ALWAYS offers an inline textarea to nudge the agent mid-flight, and stays open until a
// new rendering is ready (or the work errors) — then the user closes it to view the result.
import { useEffect, useRef, useState } from "react";

export default function AgentConsole({ active, feed = [], question, onAnswer, onSend, renderReady, errored, canClose, onClose }) {
  const [text, setText] = useState("");
  const logRef = useRef(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed, active, question]);

  if (!active) return null;

  // Only the agent's narration + events + verdicts — the live "what's happening" feed.
  const items = feed.filter((m) => m.role === "agent" || m.role === "event" || m.role === "review" || m.role === "user");

  function submit(e) {
    if (e) e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t, !!question);   // when a question is open, the parent routes this as the answer
    setText("");
  }

  const state = errored ? "error" : renderReady ? "ready" : "working";

  return (
    <div className="wi-console" role="alertdialog" aria-busy={state === "working"} aria-label="Agent at work">
      <div className="wi-console__card">
        <div className={`wi-console__head wi-console__head--${state}`}>
          {state === "working" && <span className="wi-spinner" aria-hidden="true" />}
          {state === "ready" && <span className="wi-console__tick" aria-hidden="true">✓</span>}
          {state === "error" && <span className="wi-console__bang" aria-hidden="true">!</span>}
          <span className="wi-console__title">
            {state === "ready" ? "Ready — your new version is in" : state === "error" ? "That didn't go through" : "Working on it…"}
          </span>
          <button className="wi-console__x" onClick={onClose} disabled={!canClose}
            title={canClose ? "Close and view the document" : "Hang on — finishing up…"}>✕</button>
        </div>

        <div className="wi-console__log" ref={logRef}>
          {items.length === 0 && <div className="wi-msg wi-msg--event"><span className="wi-msg__event">Starting…</span></div>}
          {items.map((m, i) => {
            if (m.role === "event") return <div key={i} className="wi-msg wi-msg--event"><span className="wi-msg__event">{m.text}</span></div>;
            if (m.role === "review") return <div key={i} className="wi-msg wi-msg--review"><span className="wi-msg__who">Review</span><span className="wi-msg__text">{m.text}</span></div>;
            return (
              <div key={i} className={`wi-msg wi-msg--${m.role}`}>
                <span className="wi-msg__who">{m.role === "user" ? "You" : "Assistant"}</span>
                <span className="wi-msg__text">{m.text}</span>
              </div>
            );
          })}
        </div>

        {question && (
          <div className="wi-console__q">
            <p className="wi-console__qtext">{question.text}</p>
            {(question.options || []).length > 0 && (
              <div className="wi-console__opts">
                {question.options.map((o) => (
                  <button key={o} className="wi-btn wi-btn--primary" onClick={() => onAnswer(o)}>{o}</button>
                ))}
              </div>
            )}
          </div>
        )}

        <form className="wi-console__compose" onSubmit={submit}>
          <textarea
            rows={1}
            value={text}
            placeholder={question ? "…or type your own answer" : "Tell the agent something — sends right away"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) submit(e); }}
          />
          <button type="submit" className="wi-send" disabled={!text.trim()} title="Send to the agent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 11l5-5 5 5M12 6v13" /></svg>
          </button>
        </form>

        {renderReady && (
          <div className="wi-console__foot">
            <button className="wi-btn wi-btn--primary" onClick={onClose}>View the document →</button>
          </div>
        )}
      </div>
    </div>
  );
}
