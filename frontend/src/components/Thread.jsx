// Thread.jsx — the conversation, as a panel that floats above the bottom composer and doubles
// as the live "agent at work" surface (ADR-0024). While the agent is working it force-opens,
// can't be collapsed, and the canvas behind it is blurred; the agent's question renders as
// inputs (you can also just type your answer in the composer below). Reviewer verdicts render
// inline. When a new render lands it flips to "Ready" and you close it to view the document.
import { useEffect, useRef, useState } from "react";

// On-theme, deliberately ephemeral filler shown while the agent is genuinely working. It fills
// the dead air between REAL wicked.interactive.status.posted updates — never replaces them. Kept short,
// tasteful, harness-flavored.
const WHIMSY = [
  "Wiring the harness…",
  "Pondering the loop…",
  "Tightening the bolts…",
  "Consulting the spine…",
  "Aligning the lanes…",
  "Reticulating splines…",
  "Checking the gates…",
];
const WHIMSY_MS = 4000;     // rotate the playful line every ~4s
const HEARTBEAT_MS = 20000; // nudge the agent for a real status every 20s while working

// --- Tiny, dependency-free markdown for agent-authored messages. Renders to React nodes (never
//     dangerouslySetInnerHTML), so message text can't inject markup. Inline: **bold**, *italic*,
//     `code`, [label](url). Block: "- "/"* " bullet lists, "1." ordered lists, blank-line para
//     breaks. The .wi-md container overrides the bubble's pre-wrap so these blocks own spacing. ---
function mdInline(text, kp) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*]+?\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t[0] === "`") out.push(<code key={`${kp}c${i}`}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={`${kp}b${i}`}>{t.slice(2, -2)}</strong>);
    else if (t[0] === "*") out.push(<em key={`${kp}i${i}`}>{t.slice(1, -1)}</em>);
    else { const rb = t.indexOf("]"); out.push(<a key={`${kp}a${i}`} href={m[5]} target="_blank" rel="noreferrer">{t.slice(1, rb)}</a>); }
    last = re.lastIndex; i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }) {
  const src = String(text == null ? "" : text).trim();
  if (!src) return null;
  return src.split(/\n{2,}/).map((block, bi) => {
    const lines = block.split(/\n/).filter((l) => l.trim() !== "");
    if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l)))
      return <ul key={bi} className="wi-md__ul">{lines.map((l, li) => <li key={li}>{mdInline(l.replace(/^\s*[-*]\s+/, ""), `${bi}.${li}.`)}</li>)}</ul>;
    if (lines.length && lines.every((l) => /^\s*\d+\.\s+/.test(l)))
      return <ol key={bi} className="wi-md__ol">{lines.map((l, li) => <li key={li}>{mdInline(l.replace(/^\s*\d+\.\s+/, ""), `${bi}.${li}.`)}</li>)}</ol>;
    return <p key={bi} className="wi-md__p">{lines.map((l, li) => <span key={li}>{li > 0 && <br />}{mdInline(l, `${bi}.${li}.`)}</span>)}</p>;
  });
}

export default function Thread({ log, open, forceOpen, lockOpen, working, realStatusAt, onHeartbeat, question, onAnswer, renderReady, onClose, onToggle, hasDoc }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, working, open, forceOpen, question]);

  // ---- "Alive while working": rotating whimsy + a 20s heartbeat. Both run ONLY while truly
  // working; both intervals clear on working-end / unmount so nothing leaks. ----
  const [whimsyIdx, setWhimsyIdx] = useState(0);
  const heartbeatRef = useRef(onHeartbeat);
  useEffect(() => { heartbeatRef.current = onHeartbeat; }, [onHeartbeat]);

  useEffect(() => {
    if (!working) return;            // not working → no timers, nothing to clean up
    setWhimsyIdx(0);                 // start fresh each working spell
    const rot = setInterval(() => setWhimsyIdx((i) => (i + 1) % WHIMSY.length), WHIMSY_MS);
    const beat = setInterval(() => { heartbeatRef.current && heartbeatRef.current(); }, HEARTBEAT_MS);
    return () => { clearInterval(rot); clearInterval(beat); };
  }, [working]);

  // A real status just landed — reset the rotation so the filler doesn't talk over it.
  useEffect(() => { if (working && realStatusAt) setWhimsyIdx(0); }, [realStatusAt, working]);

  const count = log.length;
  const hasContent = count > 0 || working || !!question || forceOpen;
  const isOpen = forceOpen || open;

  // When no content yet: show the collapsed tab (if a doc is open), or the full panel
  // if the user explicitly opened it (isOpen). Never return null when hasDoc is true.
  if (!hasContent) {
    if (!hasDoc) return null;
    if (!isOpen) {
      return (
        <button className="wi-thread-tab" onClick={onToggle} title="Open conversation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
          <span className="wi-kicker">Conversation</span>
        </button>
      );
    }
    // Panel explicitly opened with no history — show empty-state prompt.
    return (
      <div className="wi-thread" role="log" aria-label="Conversation">
        <div className="wi-thread__head">
          <span className="wi-kicker">Conversation</span>
          <button className="wi-thread__collapse" onClick={onToggle} title="Collapse">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            <span>Collapse</span>
          </button>
        </div>
        <div className="wi-thread__log">
          <div className="wi-thread__empty">
            <p>What would you like this to be?</p>
            <p className="wi-thread__empty-hint">Describe what you want in the box below and I'll build it.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isOpen) {
    return (
      <button className="wi-thread-tab" onClick={onToggle} title="Show the conversation">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
        <span className="wi-kicker">Conversation</span>
        {count > 0 && <span className="wi-thread-tab__n">{count}</span>}
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
        {renderReady ? (
          // A new version landed — the close (✕) dismisses the surface to reveal the document.
          <button
            className="wi-thread__close"
            onClick={onClose}
            title="Done — close and view the document"
          >✕</button>
        ) : lockOpen ? (
          // Actively generating/editing — the canvas IS changing, so collapse is deliberately locked.
          <button className="wi-thread__close" disabled title="Working — hang on…">⌄</button>
        ) : (
          // Not mid-edit: a clear, discoverable one-click collapse so you can review the document.
          // Labeled (not a lone glyph) per Change-1; collapses to the small tab, clearing the canvas.
          // When forceOpen=true (escape valve fired, agent went quiet), onClose clears the stale
          // agent state so forceOpen drops to false and the thread can actually close.
          <button
            className="wi-thread__collapse"
            onClick={forceOpen ? onClose : onToggle}
            title="Collapse the conversation to review the document"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            <span>Collapse</span>
          </button>
        )}
      </div>

      <div className="wi-thread__log" ref={scrollRef}>
        {log.map((m, i) => {
          if (m.role === "event") return <div key={i} className="wi-msg wi-msg--event"><span className="wi-msg__event">{m.text}</span></div>;
          if (m.role === "review") return <div key={i} className="wi-msg wi-msg--review"><span className="wi-msg__who">Review</span><div className="wi-msg__text wi-md"><Markdown text={m.text} /></div></div>;
          const isUser = m.role === "user";
          return (
            <div key={i} className={`wi-msg wi-msg--${m.role}`}>
              <span className="wi-msg__who">{isUser ? "You" : "Assistant"}</span>
              {isUser
                ? <span className="wi-msg__text">{m.text}</span>
                : <div className="wi-msg__text wi-md"><Markdown text={m.text} /></div>}
            </div>
          );
        })}
        {/* Ephemeral whimsy filler — muted/italic, aria-hidden so it never narrates to screen
            readers. The real wicked.interactive.status.posted messages above are the announced substance. */}
        {working && (
          <div className="wi-whimsy" aria-hidden="true">
            <span className="wi-typing"><span></span><span></span><span></span></span>
            <span className="wi-whimsy__text">{WHIMSY[whimsyIdx]}</span>
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
