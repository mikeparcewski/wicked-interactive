// Composer.jsx — the fixed bottom composer (ChatGPT-style). The old "+" menu is gone: its
// actions (learn-a-style, reviewers) now live on the right-edge floating tool-rail (ToolRail.jsx).
// What stays here is the message bar, the source chips, and the paperclip ATTACH affordance —
// attach is intentionally NOT on the rail (it's the composer's job, redundant with the old + item).
import { useEffect, useRef, useState } from "react";

export default function Composer({
  onSend, busy, logLen = 0,
  demoMode = false,                                   // composer mode (the toggle now lives in the top nav)
  sources = [], onRemoveSource,
  onAttach, onRecordDemo,
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; }
  }, [text]);

  // Keep --wi-composer-h in sync so the thread pill rises with the composer.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const main = wrap.closest(".wi-main");
    if (!main) return;
    const ro = new ResizeObserver(() => {
      main.style.setProperty("--wi-composer-h", `${wrap.offsetHeight}px`);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

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

  return (
    <div className="wi-composer-wrap" ref={wrapRef}>
      <div className="wi-composer">
        <form className={`wi-bar${demoMode ? " wi-bar--demo" : ""}`} onSubmit={send}>
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
        </form>

        {sources.length > 0 ? (
          <div className="wi-composer__sources" aria-label="Attached context">
            {sources.map((s) => {
              const name = s.path.split("/").filter(Boolean).pop() || s.path;
              return (
                <span key={s.path} className="wi-srcchip" title={s.path}>
                  <span className="wi-srcchip__name">📎 {name}</span>
                  {onRemoveSource && (
                    <button type="button" className="wi-srcchip__x" aria-label={`Remove ${name} from context`}
                      title="Remove from context" onClick={() => onRemoveSource(s.path)}>×</button>
                  )}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="wi-composer__hint">Click any block in the document to edit it, or just describe what you want.</p>
        )}
      </div>
    </div>
  );
}
