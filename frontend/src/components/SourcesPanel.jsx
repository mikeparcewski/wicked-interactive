// SourcesPanel.jsx — the dedicated Sources panel (ADR-0017). Lists reference material the
// user has attached for the agent to draw on. Status reflects the agent's indexing progress.
const STATUS_LABEL = { pending: "Queued", indexing: "Indexing…", indexed: "Ready", error: "Failed" };

export default function SourcesPanel({ sources = [], onAdd, narrow, onExpand }) {
  const count = sources.length;

  if (narrow) {
    return (
      <aside className="wi-sources wi-sources--collapsed">
        <button className="wi-sources__toggle" title={`Sources (${count})`} onClick={onExpand}>
          <span aria-hidden="true">📎</span>
          {count > 0 && <span className="wi-sources__badge">{count}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside className="wi-sources">
      <div className="wi-sources__head">
        <span>Sources{count > 0 ? ` · ${count}` : ""}</span>
        <button className="wi-sources__add" title="Add files or folders" onClick={onAdd}>+ Add data</button>
      </div>
      <div className="wi-sources__list">
        {count === 0 ? (
          <p className="wi-sources__empty">
            Attach files or folders for me to draw on. Nothing uploads — I read them locally.
          </p>
        ) : (
          sources.map((s) => {
            const name = s.path.split("/").filter(Boolean).pop() || s.path;
            return (
              <div key={s.path} className="wi-source" title={s.path}>
                <span className="wi-source__name">{name}</span>
                <span className="wi-source__path">{s.path}</span>
                {s.note && <span className="wi-source__note">{s.note}</span>}
                <span className={`wi-source__status wi-source__status--${s.status}`}>
                  {STATUS_LABEL[s.status] || s.status}
                </span>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
