// DocPicker.jsx — multi-document selector (ADR-0015). Hidden in legacy single-doc mode.
export default function DocPicker({ docs, current, onSelect, onNew }) {
  if (!docs || docs.length === 0) return (
    <button className="wi-btn wi-btn--ghost" onClick={onNew}>+ New document</button>
  );
  return (
    <div className="wi-doc-picker">
      <select value={current || ""} onChange={(e) => onSelect(e.target.value)}>
        {!current && <option value="">— select a document —</option>}
        {docs.map((d) => (
          <option key={d.name} value={d.name}>{d.name} (v{d.head})</option>
        ))}
      </select>
      <button className="wi-btn wi-btn--ghost" onClick={onNew}>+ New</button>
    </div>
  );
}
