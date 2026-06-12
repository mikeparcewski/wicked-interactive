// ToolRail.jsx — a vertical floating tool-rail docked to the right edge of the canvas pane
// (Adobe-style). Icon-only buttons; the label shows as a native tooltip on hover. It holds the
// actions that used to live in the composer's + menu:
//   • Style → learn from a website / PDF-image → document-changing (kickoff/veil, one at a time)
//   • Analyze → reviewers (Intent / A11y / Copy / Quality) → NON-BLOCKING + CONCURRENT: clicking
//     one starts THAT review in the background, shows an in-progress spinner on its button, and
//     streams the verdict into the conversation Thread. Many can run at once; none veil the canvas.
// Upload stays on the composer paperclip — it is intentionally NOT on the rail.

// The four review passes. `short` is the (tooltip) name; `label`/`sub` describe the pass.
//   • Intent (semantic-reviewer): does the current version still match the original ask/intent.
export const REVIEWERS = [
  { key: "match", short: "Intent", do: "Check it still matches your original ask" },
  { key: "a11y", short: "A11y", do: "Check accessibility & contrast (WCAG AA)" },
  { key: "copy", short: "Copy", do: "Tighten the copy & clarity" },
  { key: "qe", short: "Quality", do: "Run the full quality crew" },
];

// reviewer key → human label, exported so App can name it in the thread.
export const REVIEW_LABEL = Object.fromEntries(REVIEWERS.map((r) => [r.key, r.short]));

const REVIEW_GLYPH = {
  match: <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />, // checklist / intent
  a11y: <><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /></>, // eye
  copy: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />, // pencil
  qe: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4" />, // shield-check
};

function RailButton({ title, tip, busy, on, onClick, children }) {
  return (
    <button
      type="button"
      className={`wi-toolrail__btn${on ? " is-on" : ""}${busy ? " is-busy" : ""}`}
      title={title}
      data-tip={tip || title}
      aria-label={title}
      aria-pressed={on || undefined}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {busy ? <span className="wi-spinner wi-toolrail__spin" /> : (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
      )}
    </button>
  );
}

export default function ToolRail({ onLearnWebsite, onLearnFile, reviewInFlight = {}, onStartReview }) {
  const hasLearn = !!(onLearnWebsite || onLearnFile);
  const hasReviewers = !!onStartReview;
  if (!hasLearn && !hasReviewers) return null;

  return (
    <div className="wi-toolrail" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {hasLearn && (
        <div className="wi-toolrail__group" role="group" aria-label="Style">
          <span className="wi-toolrail__cap">Style</span>
          {onLearnWebsite && (
            <RailButton title="Style — learn from a website" tip="Match the look of a website" onClick={onLearnWebsite}>
              <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
            </RailButton>
          )}
          {onLearnFile && (
            <RailButton title="Style — learn from a PDF or image (stays on your machine)" tip="Match the look of a PDF or image" onClick={onLearnFile}>
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="M21 15l-5-5L5 21" />
            </RailButton>
          )}
        </div>
      )}

      {hasReviewers && (
        <div className="wi-toolrail__group" role="group" aria-label="Analyze">
          <span className="wi-toolrail__cap">Analyze</span>
          {REVIEWERS.map((r) => (
            <RailButton
              key={r.key}
              title={`${r.short} — ${r.do}`}
              tip={`${r.do}${reviewInFlight[r.key] ? " — running…" : ""}`}
              busy={!!reviewInFlight[r.key]}
              onClick={() => onStartReview(r.key)}
            >
              {REVIEW_GLYPH[r.key]}
            </RailButton>
          ))}
        </div>
      )}
    </div>
  );
}
