// Overlay.jsx — highlight boxes over the iframe + a corner ✕ to delete a block (ADR-0013).
// Lives above the iframe; boxes pass clicks through, the ✕ button captures them.
export default function Overlay({ rects, pending, hovered, selected, onRemove }) {
  return (
    <div className="wi-overlay" aria-hidden="true">
      {Object.entries(rects).map(([sel, r]) => {
        const classes = ["wi-box"];
        if (pending.has(sel)) classes.push("wi-box--pending");
        if (sel === hovered) classes.push("wi-box--hover");
        if (sel === selected) classes.push("wi-box--selected");
        if (classes.length === 1) return null;
        const showX = onRemove && (sel === hovered || sel === selected);
        return (
          <div key={sel} className={classes.join(" ")} style={{ top: r.top, left: r.left, width: r.width, height: r.height }}>
            {pending.has(sel) && <span className="wi-box__tag">edit pending</span>}
            {showX && (
              <button
                className="wi-box__x"
                title="Remove this element"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(sel); }}
              >×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
