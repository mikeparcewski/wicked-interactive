// InlineComment.jsx — popover at the clicked block (ADR-0013/0014). Three modes:
//   This block  → a comment the agent interprets (structural-change, AI)
//   Change text → type the exact new text (content-edit, deterministic, instant)
//   Whole section → a comment on the enclosing section (structural-change, AI)
import { useEffect, useState } from "react";

export default function InlineComment({ selected, rect, onSubmit, onCancel }) {
  const [mode, setMode] = useState("block-comment");
  const [text, setText] = useState("");

  useEffect(() => { setMode("block-comment"); setText(""); }, [selected]);
  // Seed exact-text mode with the current text; clear it for comment modes.
  useEffect(() => { setText(mode === "change-text" ? (selected?.before ?? "") : ""); }, [mode, selected]);

  if (!selected || !rect) return null;
  const top = Math.max(8, rect.top + rect.height + 8);
  const left = Math.max(8, Math.min(rect.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - 360));

  function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    onSubmit({ mode, text: text.trim() });
  }

  return (
    <div className="wi-inline" style={{ top, left }}>
      <form onSubmit={submit}>
        <div className="wi-inline__scope">
          <button type="button" className={mode === "block-comment" ? "on" : ""} onClick={() => setMode("block-comment")}>This block</button>
          <button type="button" className={mode === "change-text" ? "on" : ""} onClick={() => setMode("change-text")}>Change text</button>
          {selected.section && (
            <button type="button" className={mode === "section-comment" ? "on" : ""} onClick={() => setMode("section-comment")}>Whole section</button>
          )}
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={mode === "change-text"
            ? "Exact new text…"
            : mode === "section-comment"
              ? "Comment on this section… e.g. “too dark, lighten it”"
              : `Comment on this ${selected.tag}… e.g. “shorten this”, “make it blue”`}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e); if (e.key === "Escape") onCancel(); }}
        />
        <div className="wi-inline__actions">
          <button type="submit" className="wi-btn wi-btn--primary" disabled={!text.trim()}>
            {mode === "change-text" ? "Apply" : "Send"}
          </button>
          <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
