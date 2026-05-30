// FsPicker.jsx — local path picker (ADR-0017). The page can't read real disk paths from
// <input type=file>, so the user navigates their own machine here and we hand back absolute
// paths. No uploads: the service is local and the agent reads the paths directly.
import { useCallback, useEffect, useState } from "react";
import { browseFs } from "../lib/api.js";

export default function FsPicker({ open, onAdd, onCancel }) {
  const [cwd, setCwd] = useState(null);     // { path, parent, home, entries }
  const [picked, setPicked] = useState({}); // path -> { name, dir }
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const go = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try { setCwd(await browseFs(path)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (open) { setPicked({}); setNote(""); setError(null); go(); }
  }, [open, go]);

  if (!open) return null;

  const toggle = (e) => setPicked((p) => {
    const next = { ...p };
    if (next[e.path]) delete next[e.path]; else next[e.path] = { name: e.name, dir: e.dir };
    return next;
  });

  const pickedList = Object.keys(picked);
  const confirm = () => { if (pickedList.length) onAdd(pickedList, note.trim()); };

  // Render the current path as clickable breadcrumb segments.
  const segs = cwd ? cwd.path.split("/").filter(Boolean) : [];
  const segPath = (i) => "/" + segs.slice(0, i + 1).join("/");

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal wi-fspicker" onClick={(ev) => ev.stopPropagation()}>
        <h3 className="wi-modal__title">Add data</h3>
        <p className="wi-modal__hint">
          Browse your machine and pick files or folders for me to draw on. Nothing is uploaded —
          I read these paths directly and index them into this document's knowledge.
        </p>

        <div className="wi-fspicker__bar">
          <button type="button" className="wi-fspicker__nav" disabled={!cwd?.parent || loading}
            onClick={() => go(cwd.parent)} title="Up one level" aria-label="Up one level">↑</button>
          <button type="button" className="wi-fspicker__nav" disabled={loading}
            onClick={() => go(cwd?.home)} title="Home" aria-label="Home">⌂</button>
          <div className="wi-fspicker__crumbs">
            <button type="button" className="wi-fspicker__crumb" onClick={() => go("/")}>/</button>
            {segs.map((s, i) => (
              <button type="button" key={i} className="wi-fspicker__crumb" onClick={() => go(segPath(i))}>{s}</button>
            ))}
          </div>
        </div>

        <div className="wi-fspicker__list" role="listbox" aria-label="Files and folders">
          {error && <div className="wi-modal__error">{error}</div>}
          {!error && cwd?.entries.length === 0 && <div className="wi-fspicker__empty">Empty folder</div>}
          {!error && cwd?.entries.map((e) => {
            const checked = !!picked[e.path];
            return (
              <div key={e.path} className={`wi-fspicker__row ${checked ? "is-picked" : ""}`}>
                <label className="wi-fspicker__check">
                  <input type="checkbox" checked={checked} onChange={() => toggle(e)} />
                </label>
                <button type="button" className="wi-fspicker__name" disabled={!e.dir}
                  onClick={() => e.dir && go(e.path)} title={e.dir ? "Open folder" : e.path}>
                  <span className="wi-fspicker__glyph" aria-hidden="true">{e.dir ? "📁" : "📄"}</span>
                  <span className="wi-fspicker__label">{e.name}</span>
                  {e.dir && <span className="wi-fspicker__chev" aria-hidden="true">›</span>}
                </button>
              </div>
            );
          })}
        </div>

        {pickedList.length > 0 && (
          <div className="wi-fspicker__picked">
            {pickedList.map((p) => (
              <span key={p} className="wi-fspicker__chip" title={p}>
                {picked[p].dir ? "📁" : "📄"} {picked[p].name}
                <button type="button" onClick={() => toggle({ path: p, ...picked[p] })} aria-label="Unpick">×</button>
              </span>
            ))}
          </div>
        )}

        <label className="wi-modal__field">
          Note for me <span className="wi-modal__optional">(optional — how to use these)</span>
          <textarea value={note} onChange={(ev) => setNote(ev.target.value)} rows={2}
            placeholder="Use the Q3 figures from the spreadsheet; tone from the brand deck." />
        </label>

        <div className="wi-modal__actions">
          <button type="button" className="wi-btn wi-btn--primary" disabled={pickedList.length === 0} onClick={confirm}>
            Add {pickedList.length || ""} {pickedList.length === 1 ? "item" : "items"}
          </button>
          <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
