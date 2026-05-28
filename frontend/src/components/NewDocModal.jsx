// NewDocModal.jsx — create a new document (ADR-0015). Two modes:
//   "Describe" — type what the document should be; we seed it with a minimal shell and
//                stash the description so the agent can develop it from the first chat.
//   "HTML"     — paste exact HTML for v0.
import { useEffect, useState } from "react";

export default function NewDocModal({ open, onCreate, onCancel, error }) {
  const [mode, setMode] = useState("describe");
  const [name, setName] = useState("");
  const [text, setText] = useState("");

  useEffect(() => { if (open) { setMode("describe"); setName(""); setText(""); } }, [open]);
  if (!open) return null;

  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const titleCase = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const seedFromDescription = (n, desc) =>
    `<section>` +
      `<h1>${escapeHtml(titleCase(n) || "New document")}</h1>` +
      `<p class="lead">${escapeHtml(desc)}</p>` +
      `<p>Click any block and comment, or talk to the assistant in the chat to develop this.</p>` +
    `</section>`;

  const valid = name.trim().length > 0 && text.trim().length > 0;

  function submit(e) {
    e.preventDefault();
    const n = name.trim();
    if (mode === "describe") {
      onCreate(n, seedFromDescription(n, text.trim()), { kind: "describe", prompt: text.trim() });
    } else {
      onCreate(n, text, { kind: "html" });
    }
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">New document</h3>
        <p className="wi-modal__hint">Names are slug-safe (lowercase letters, digits, hyphens).</p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-brochure" autoFocus spellCheck={false} />
          </label>
          <div className="wi-modal__tabs">
            <button type="button" className={`wi-modal__tab${mode === "describe" ? " on" : ""}`} onClick={() => setMode("describe")}>Describe it</button>
            <button type="button" className={`wi-modal__tab${mode === "html" ? " on" : ""}`} onClick={() => setMode("html")}>Paste HTML</button>
          </div>
          {mode === "describe" ? (
            <label className="wi-modal__field">
              What should this document be?
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
                placeholder='e.g. "A one-page launch announcement for our Q3 release: hero, three feature highlights, a quote from a customer, and a CTA to book a demo. Cutting-edge tech aesthetic, dark mode."' />
            </label>
          ) : (
            <label className="wi-modal__field">
              Initial HTML
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
                placeholder="<section><h1>...</h1><p>...</p></section>" spellCheck={false} className="wi-modal__mono" />
            </label>
          )}
          {error && <div className="wi-modal__error">{error}</div>}
          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!valid}>Create</button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
