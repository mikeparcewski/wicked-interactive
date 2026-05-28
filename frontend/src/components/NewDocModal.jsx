// NewDocModal.jsx — create a new document (ADR-0015).
//
// Direction (2026-05-28): HTML is optional. Default flow is "name → blank doc → chat to
// build". Power users can still paste exact HTML to seed v0. The chat panel opens on
// arrival so the user knows where to start.
import { useEffect, useState } from "react";

export default function NewDocModal({ open, onCreate, onCancel, error }) {
  const [name, setName] = useState("");
  const [html, setHtml] = useState("");
  const [showHtml, setShowHtml] = useState(false);

  useEffect(() => { if (open) { setName(""); setHtml(""); setShowHtml(false); } }, [open]);
  if (!open) return null;

  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const titleCase = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const blankSeed = (n) =>
    `<section>` +
      `<h1>${escapeHtml(titleCase(n) || "New document")}</h1>` +
      `<p class="lead">Empty document — open the chat on the left to brainstorm and build it.</p>` +
    `</section>`;

  const trimmedName = name.trim();
  const trimmedHtml = html.trim();
  const valid = trimmedName.length > 0;

  function submit(e) {
    e.preventDefault();
    const seed = trimmedHtml || blankSeed(trimmedName);
    onCreate(trimmedName, seed, { kind: trimmedHtml ? "html" : "blank" });
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">New document</h3>
        <p className="wi-modal__hint">
          Pick a name. Skip the HTML and you'll land on an empty doc — the chat on the left is
          where you brainstorm and build it. Names are slug-safe (lowercase letters, digits,
          hyphens).
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-brochure" autoFocus spellCheck={false} />
          </label>

          {!showHtml ? (
            <button type="button" className="wi-modal__disclosure" onClick={() => setShowHtml(true)}>
              Have HTML to start from? <span>Paste it →</span>
            </button>
          ) : (
            <label className="wi-modal__field">
              Initial HTML <span className="wi-modal__optional">(optional)</span>
              <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={10}
                placeholder="<section><h1>...</h1><p>...</p></section>" spellCheck={false} className="wi-modal__mono" />
            </label>
          )}

          {error && <div className="wi-modal__error">{error}</div>}
          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!valid}>
              Create {trimmedHtml ? "from HTML" : "blank doc"}
            </button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
