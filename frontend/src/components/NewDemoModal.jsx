// NewDemoModal.jsx — create a new demo (ADR-0018).
//
// A demo points at a live application URL. The supervising agent explores it, authors a
// deterministic Playwright click-path (demo.spec.mjs), and the service records it as a
// storyboard version — the same highlight-a-block / give-feedback / regenerate loop as a
// document, except "regenerate" re-authors the spec and re-records.
import { useEffect, useState } from "react";

export default function NewDemoModal({ open, onCreate, onCancel, error }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [brief, setBrief] = useState("");

  useEffect(() => {
    if (open) { setName(""); setUrl(""); setBrief(""); }
  }, [open]);
  if (!open) return null;

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const trimmedBrief = brief.trim();

  let urlOk = false;
  try { const u = new URL(trimmedUrl); urlOk = u.protocol === "http:" || u.protocol === "https:"; } catch { urlOk = false; }
  const valid = trimmedName.length > 0 && urlOk;

  function submit(e) {
    e.preventDefault();
    if (!valid) return;
    onCreate(trimmedName, "", { kind: "demo", url: trimmedUrl, brief: trimmedBrief });
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">New demo</h3>
        <p className="wi-modal__hint">
          Point at a running app. I'll explore it, work out the click-path for what you describe,
          and record a walkthrough you can refine block-by-block — just like a document. Names are
          slug-safe (lowercase letters, digits, hyphens).
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-demo" autoFocus spellCheck={false} />
          </label>

          <label className="wi-modal__field">
            App URL
            <input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://staging.example.com/app" spellCheck={false} className="wi-modal__mono" />
            {trimmedUrl && !urlOk && <span className="wi-modal__optional">Enter a full http(s) URL.</span>}
          </label>

          <label className="wi-modal__field">
            What should the demo show? <span className="wi-modal__optional">(optional — describe the flow)</span>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
              placeholder="Sign in, add the Pro plan to the cart, and walk through checkout." />
          </label>

          {error && <div className="wi-modal__error">{error}</div>}
          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!valid}>Create demo</button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
