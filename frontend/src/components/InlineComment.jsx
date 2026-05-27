// InlineComment.jsx — a popover anchored at the clicked block (ADR-0013). One plain
// comment; the agent figures out intent. Optional block/section scope. No sidebar.
import { useEffect, useState } from "react";

export default function InlineComment({ selected, rect, onSubmit, onCancel }) {
  const [comment, setComment] = useState("");
  const [scope, setScope] = useState("block");

  useEffect(() => { setComment(""); setScope("block"); }, [selected]);
  if (!selected || !rect) return null;

  const top = Math.max(8, rect.top + rect.height + 8);
  const left = Math.max(8, Math.min(rect.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - 360));
  const what = scope === "section" ? "section" : selected.tag;

  function submit(e) {
    e.preventDefault();
    if (!comment.trim()) return;
    onSubmit({ comment: comment.trim(), scope });
  }

  return (
    <div className="wi-inline" style={{ top, left }}>
      <form onSubmit={submit}>
        {selected.section && (
          <div className="wi-inline__scope">
            <button type="button" className={scope === "block" ? "on" : ""} onClick={() => setScope("block")}>this block</button>
            <button type="button" className={scope === "section" ? "on" : ""} onClick={() => setScope("section")}>whole section</button>
          </div>
        )}
        <textarea
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder={`Comment on this ${what}… e.g. “shorten this”, “make it blue”, or the exact new text`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="wi-inline__actions">
          <button type="submit" className="wi-btn wi-btn--primary" disabled={!comment.trim()}>Send</button>
          <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
