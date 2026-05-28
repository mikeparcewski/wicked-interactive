// NewDocModal.jsx — create a new document workspace (ADR-0015).
import { useState } from "react";

export default function NewDocModal({ open, onCreate, onCancel, error }) {
  const [name, setName] = useState("");
  const [html, setHtml] = useState("");
  if (!open) return null;
  const valid = name.trim().length > 0 && html.trim().length > 0;
  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">New document</h3>
        <p className="wi-modal__hint">Names are slug-safe (lowercase letters, digits, hyphens). Paste any HTML to seed v0.</p>
        <label className="wi-modal__field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-brochure" autoFocus spellCheck={false} />
        </label>
        <label className="wi-modal__field">
          Initial HTML
          <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12}
            placeholder="<section><h1>...</h1><p>...</p></section>" spellCheck={false} />
        </label>
        {error && <div className="wi-modal__error">{error}</div>}
        <div className="wi-modal__actions">
          <button className="wi-btn wi-btn--primary" disabled={!valid} onClick={() => onCreate(name.trim(), html)}>Create</button>
          <button className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
