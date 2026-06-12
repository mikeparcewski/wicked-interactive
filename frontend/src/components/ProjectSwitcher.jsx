// ProjectSwitcher.jsx — sits at the top of the sidebar (above New document). Shows the current
// project (and its root PATH when the sidebar is expanded, so you never forget where you're
// working), and — if other live `serve` instances are registered — a menu to jump to one (each is
// a separate daemon, so switching navigates the browser to that instance's URL). ADR-0025.
import { useState } from "react";

export default function ProjectSwitcher({ projects = [], currentRoot, expanded }) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.current)
    || (currentRoot ? { name: (currentRoot.split("/").filter(Boolean).pop() || currentRoot), root: currentRoot, current: true } : null);
  if (!current) return null;
  const others = projects.filter((p) => !p.current);

  return (
    <div className={`wi-proj${open ? " is-open" : ""}`}>
      <button
        className="wi-proj__btn"
        title={others.length ? `${current.root} — switch project` : current.root}
        onClick={() => others.length && setOpen((o) => !o)}
        aria-haspopup={others.length ? "menu" : undefined}
        aria-expanded={others.length ? open : undefined}
      >
        <span className="wi-proj__glyph" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span className="wi-proj__meta">
          <span className="wi-proj__name">{current.name}</span>
          {expanded && <span className="wi-proj__root" title={current.root}>{current.root}</span>}
        </span>
        {others.length > 0 && <span className="wi-proj__chev" aria-hidden="true">⌄</span>}
      </button>

      {open && others.length > 0 && (
        <div className="wi-proj__menu" role="menu">
          <div className="wi-proj__menu-cap">Switch to</div>
          {others.map((p) => (
            <a key={p.root} className="wi-proj__item" role="menuitem" href={p.url} title={p.root}>
              <span className="wi-proj__item-name">{p.name}</span>
              <span className="wi-proj__item-root">{p.root}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
