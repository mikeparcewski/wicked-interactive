// NewDocModal.jsx — create a new document (ADR-0015).
//
// Three ways to start:
//   1. blank   — name only → empty doc → brainstorm in chat (the default).
//   2. html    — paste exact HTML to seed v0 (power users).
//   3. source  — "From my content": point at files/a folder + an optional brief; the
//                supervising agent indexes them (wicked-prezzie / wicked-brain) and builds
//                the first draft. Most people arrive with material, not finished HTML.
import { useEffect, useState } from "react";

export default function NewDocModal({ open, onCreate, onCancel, error }) {
  const [name, setName] = useState("");
  const [html, setHtml] = useState("");
  const [showHtml, setShowHtml] = useState(false);
  const [sourcePaths, setSourcePaths] = useState([""]);
  const [brief, setBrief] = useState("");
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (open) { setName(""); setHtml(""); setShowHtml(false); setSourcePaths([""]); setBrief(""); setShowSource(false); }
  }, [open]);
  if (!open) return null;

  const setPathAt = (i, v) => setSourcePaths((ps) => ps.map((p, j) => (j === i ? v : p)));
  const addPath = () => setSourcePaths((ps) => [...ps, ""]);
  const removePathAt = (i) => setSourcePaths((ps) => (ps.length === 1 ? [""] : ps.filter((_, j) => j !== i)));
  const cleanPaths = sourcePaths.map((p) => p.trim()).filter(Boolean);

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
    // Precedence: source > html > blank.
    if (cleanPaths.length) {
      onCreate(trimmedName, "", { kind: "source", sourcePaths: cleanPaths, brief: brief.trim() });
    } else {
      const seed = trimmedHtml || blankSeed(trimmedName);
      onCreate(trimmedName, seed, { kind: trimmedHtml ? "html" : "blank" });
    }
  }

  const ctaLabel = cleanPaths.length ? "Build from my content" : trimmedHtml ? "Create from HTML" : "Create blank doc";

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">New document</h3>
        <p className="wi-modal__hint">
          Pick a name. Skip everything else and you'll land on an empty doc — the chat on the
          left is where you brainstorm and build it. Names are slug-safe (lowercase letters,
          digits, hyphens).
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-brochure" autoFocus spellCheck={false} />
          </label>

          {!showSource ? (
            <button type="button" className="wi-modal__disclosure" onClick={() => setShowSource(true)}>
              Already have the content? <span>Build from my files →</span>
            </button>
          ) : (
            <>
              <div className="wi-modal__field">
                Build from my content <span className="wi-modal__optional">(files or folders on your machine)</span>
                <div className="wi-paths">
                  {sourcePaths.map((p, i) => (
                    <div className="wi-paths__row" key={i}>
                      <input value={p} onChange={(e) => setPathAt(i, e.target.value)}
                        placeholder="~/Documents/q3-notes  or  ./decks/raw" spellCheck={false} className="wi-modal__mono" />
                      <button type="button" className="wi-paths__remove" onClick={() => removePathAt(i)}
                        aria-label="Remove this location" title="Remove">×</button>
                    </div>
                  ))}
                </div>
                <button type="button" className="wi-paths__add" onClick={addPath}>+ Add another file or folder</button>
              </div>
              <label className="wi-modal__field">
                What should it become? <span className="wi-modal__optional">(optional brief)</span>
                <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3}
                  placeholder="A 6-slide investor update — lead with the ARR chart, keep it punchy." />
              </label>
            </>
          )}

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
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!valid}>{ctaLabel}</button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
