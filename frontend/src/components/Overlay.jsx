// Overlay.jsx — presentational. Given box rects keyed by selector, draws highlight
// outlines over the iframe. Lives ABOVE the iframe in the React tree (ADR-0006), so it
// survives version swaps. Pointer-events pass through to the iframe.

export default function Overlay({ rects, pending, hovered, selected }) {
  return (
    <div className="wi-overlay" aria-hidden="true">
      {Object.entries(rects).map(([sel, r]) => {
        const classes = ["wi-box"];
        if (pending.has(sel)) classes.push("wi-box--pending");
        if (sel === hovered) classes.push("wi-box--hover");
        if (sel === selected) classes.push("wi-box--selected");
        if (classes.length === 1) return null; // nothing to draw for this block
        return (
          <div
            key={sel}
            className={classes.join(" ")}
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
          >
            {pending.has(sel) && <span className="wi-box__tag">edit pending</span>}
          </div>
        );
      })}
    </div>
  );
}
