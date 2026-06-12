// Composer.jsx — the fixed bottom composer (ChatGPT-style) with a + menu.
// The menu grows by capability: sections render only when their handler is supplied, so
// Phase 1 shows what already works (learn-from-website, attach, record) and later phases
// pass more (PDF/image learn, reviewers).
import { useEffect, useRef, useState } from "react";

export const REVIEWERS = [
  { key: "match", label: "Does it match the ask", sub: "semantic-reviewer", short: "Matches ask" },
  { key: "a11y", label: "Accessibility + contrast", sub: "WCAG-AA pass", short: "A11y" },
  { key: "copy", label: "Copy & clarity", sub: "editorial pass", short: "Copy" },
  { key: "qe", label: "Full QE crew", sub: "wicked-testing reviewers", short: "QE crew" },
];

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
);

export default function Composer({
  onSend, busy, logLen = 0,
  sources = [],
  onLearnWebsite, onLearnFile, onAttach, onRecordDemo,
  reviewers, onToggleReviewer, onReviewNow,
}) {
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [demoMode, setDemoMode] = useState(false);   // false = Interactive (default), true = Demo recording
  const taRef = useRef(null);

  // The demo toggle is only meaningful when the demo capability is wired (onRecordDemo present).
  // If it disappears (e.g. navigating to a context without it), fall back to Interactive.
  useEffect(() => { if (!onRecordDemo && demoMode) setDemoMode(false); }, [onRecordDemo, demoMode]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; }
  }, [text]);

  // Clear the optimistic "sending" flag once the transcript grows (server echoed the message).
  useEffect(() => { setSending(false); }, [logLen]);

  function send(e) {
    if (e) e.preventDefault();
    // Demo-recording mode: the send action triggers the existing demo flow rather than a chat.
    // It doesn't require composer text (the walkthrough is captured, not typed).
    if (demoMode && onRecordDemo) { onRecordDemo(); return; }
    const t = text.trim();
    if (!t) return;
    setSending(true);
    onSend(t);
    setText("");
  }

  const hasLearn = !!(onLearnWebsite || onLearnFile);
  const hasReviewers = !!(reviewers && onToggleReviewer);
  const hasExtras = !!onAttach;
  const activeReviewers = reviewers ? REVIEWERS.filter((r) => reviewers[r.key]) : [];

  const pick = (fn) => () => { setMenuOpen(false); fn && fn(); };

  return (
    <div className="wi-composer-wrap">
      <div className="wi-composer">
        {(sources.length > 0 || activeReviewers.length > 0) && (
          <div className="wi-composer__chips">
            {sources.map((s) => {
              const name = s.path.split("/").filter(Boolean).pop() || s.path;
              return <span key={s.path} className="wi-chip" title={s.path}>📎 {name}</span>;
            })}
            {activeReviewers.length > 0 && (
              <span className="wi-chip wi-chip--review" title="Press “Review the current version now” in the + menu to run these">
                <span className="wi-chip__dot" aria-hidden="true" />
                Reviewers: {activeReviewers.map((r) => r.short).join(" · ")}
              </span>
            )}
          </div>
        )}

        {onRecordDemo && (
          <div className="wi-modeswitch" role="group" aria-label="Composer mode">
            <button
              type="button"
              className={`wi-modeswitch__opt${!demoMode ? " is-on" : ""}`}
              aria-pressed={!demoMode}
              onClick={() => setDemoMode(false)}
            >
              Interactive
            </button>
            <button
              type="button"
              className={`wi-modeswitch__opt${demoMode ? " is-on" : ""}`}
              aria-pressed={demoMode}
              onClick={() => setDemoMode(true)}
            >
              ● Demo recording
            </button>
          </div>
        )}

        <form className={`wi-bar${demoMode ? " wi-bar--demo" : ""}`} onSubmit={send}>
          <button
            type="button"
            className={`wi-iconbtn wi-iconbtn--plus${menuOpen ? " is-open" : ""}`}
            title="Add — learn a style, reviewers, files"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>

          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={demoMode
              ? "Demo recording — press send to capture a walkthrough of your app…"
              : "Describe a change, or click a block in the document…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(e); }}
          />

          {onAttach && (
            <button type="button" className="wi-iconbtn" title="Attach a file (stays on your machine)" onClick={onAttach}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            </button>
          )}

          <button type="submit" className="wi-send" title={demoMode ? "Record a demo walkthrough" : "Send"} disabled={busy || sending || (!demoMode && !text.trim())}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 11l5-5 5 5M12 6v13" /></svg>
          </button>

          {menuOpen && (
            <div className="wi-plusmenu" role="menu">
              {hasLearn && (
                <div className="wi-plusmenu__sec">
                  <span className="wi-kicker">Learn a style</span>
                  {onLearnWebsite && (
                    <button type="button" className="wi-plusmenu__item" onClick={pick(onLearnWebsite)}>
                      <span className="wi-plusmenu__ic">🌐</span>
                      <span className="wi-plusmenu__mt">From a website<small>I'll browse a few pages → PDF → match the look</small></span>
                    </button>
                  )}
                  {onLearnFile && (
                    <button type="button" className="wi-plusmenu__item" onClick={pick(onLearnFile)}>
                      <span className="wi-plusmenu__ic">🖼️</span>
                      <span className="wi-plusmenu__mt">From a PDF or image<small>Stays on your machine</small></span>
                    </button>
                  )}
                </div>
              )}

              {hasReviewers && (
                <>
                  {hasLearn && <div className="wi-plusmenu__sep" />}
                  <div className="wi-plusmenu__sec">
                    <span className="wi-kicker">Reviewers — run a review pass</span>
                    {REVIEWERS.map((r) => (
                      <div
                        key={r.key}
                        className={`wi-rev${reviewers[r.key] ? " is-on" : ""}`}
                        role="menuitemcheckbox"
                        aria-checked={!!reviewers[r.key]}
                        tabIndex={0}
                        onClick={() => onToggleReviewer(r.key)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleReviewer(r.key); } }}
                      >
                        <span className="wi-rev__box"><Check /></span>
                        <span className="wi-rev__t">{r.label}<small>{r.sub}</small></span>
                      </div>
                    ))}
                    {onReviewNow && (
                      <div className="wi-plusmenu__runrow">
                        <button type="button" className="wi-plusmenu__run" onClick={pick(onReviewNow)}>Review the current version now</button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {hasExtras && (
                <>
                  {(hasLearn || hasReviewers) && <div className="wi-plusmenu__sep" />}
                  <div className="wi-plusmenu__sec">
                    {onAttach && (
                      <button type="button" className="wi-plusmenu__item" onClick={pick(onAttach)}>
                        <span className="wi-plusmenu__ic">📁</span>
                        <span className="wi-plusmenu__mt">Attach files or data<small>Point at local files — read in place</small></span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </form>

        <p className="wi-composer__hint">
          Click any block in the document to edit it, or just describe what you want. <b>The supervising agent is the intelligence in the loop.</b>
        </p>
      </div>

      {menuOpen && <div className="wi-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
    </div>
  );
}
