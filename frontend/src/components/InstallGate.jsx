// InstallGate.jsx — install-gate UI for ADR-0016. Blocks the editor when any required
// sibling plugin is missing. The user has one action: install the listed plugins.
//
// Props:
//   preflight — { ok, missing[], required:{name:{detected}}, install_hint }
//   onRetry   — re-runs the preflight check (after the user installs the plugins)
export default function InstallGate({ preflight, onRetry }) {
  if (!preflight || preflight.ok) return null;
  const required = preflight.required || {};
  const hint = preflight.install_hint || [
    "/plugin marketplace add mikeparcewski/wicked-prezzie",
    "/plugin install wicked-prezzie",
    "",
    "/plugin marketplace add mikeparcewski/wicked-garden",
    "/plugin install wicked-garden",
    "",
    "npx wicked-brain",
  ].join("\n");

  return (
    <div className="wi-gate" role="alertdialog" aria-labelledby="wi-gate-title">
      <div className="wi-gate__panel">
        <h2 id="wi-gate-title" className="wi-gate__title">Missing sibling plugins</h2>
        <p className="wi-gate__body">
          wicked-interactive needs these Claude Code plugins installed before the editor will work.
          Theme, crews, and knowledge queries all live in them.
        </p>
        <ul className="wi-gate__list">
          {Object.entries(required).map(([name, info]) => (
            <li key={name} className={`wi-gate__item wi-gate__item--${info.detected ? "ok" : "miss"}`}>
              <span className="wi-gate__dot" aria-hidden>{info.detected ? "●" : "○"}</span>
              <code>{name}</code>
              <span className="wi-gate__status">{info.detected ? "installed" : "missing"}</span>
            </li>
          ))}
        </ul>
        <p className="wi-gate__cta">Run this once, then come back:</p>
        <pre className="wi-gate__cmd"><code>{hint}</code></pre>
        <div className="wi-gate__actions">
          <button className="wi-btn wi-btn--primary" onClick={onRetry}>I've installed them — check again</button>
        </div>
        {preflight.unreachable && (
          <p className="wi-gate__warn">Couldn't reach the preflight endpoint — the service may be restarting.</p>
        )}
      </div>
    </div>
  );
}
