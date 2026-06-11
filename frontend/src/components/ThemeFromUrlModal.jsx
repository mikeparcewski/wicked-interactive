// ThemeFromUrlModal.jsx — "Learn a theme from a URL" (ADR-0010/ADR-0020).
//
// Point at a live page whose look you like. The service grabs it to a PDF (deterministic infra);
// the supervising agent reads the design with vision — palette, type scale, spacing, card
// treatment — synthesizes a theme, and re-themes the current document. No name field: this acts
// on the current doc, so one URL is all we need. URL validation mirrors NewDemoModal.
import { useEffect, useState } from "react";

export default function ThemeFromUrlModal({ open, onSubmit, onCancel, error }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (open) setUrl("");
  }, [open]);
  if (!open) return null;

  const trimmedUrl = url.trim();
  let urlOk = false;
  try { const u = new URL(trimmedUrl); urlOk = u.protocol === "http:" || u.protocol === "https:"; } catch { urlOk = false; }

  function submit(e) {
    e.preventDefault();
    if (!urlOk) return;
    onSubmit(trimmedUrl);
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">Learn a theme from a URL</h3>
        <p className="wi-modal__hint">
          Point at a page whose look you like. I'll grab it, read the design — colors, fonts,
          spacing, the overall feel — and re-theme this document to match. A new version lands when
          it's ready.
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            Page URL
            <input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://stripe.com" autoFocus spellCheck={false} className="wi-modal__mono" />
            {trimmedUrl && !urlOk && <span className="wi-modal__optional">Enter a full http(s) URL.</span>}
          </label>

          {error && <div className="wi-modal__error">{error}</div>}
          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!urlOk}>Learn theme</button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
