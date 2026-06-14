// DemoStoryboard.jsx — video-player view for demo docs.
//
// Layout: primary scene sidebar (left) + dark video player (right).
// Chapters are parsed from the storyboard HTML via fetch (not an iframe).
import { useCallback, useEffect, useRef, useState } from "react";

export default function DemoStoryboard({
  currentDoc,
  viewing,
  storyboardUrl,  // URL to fetch storyboard HTML (for chapter extraction)
  videoSrc,       // URL for the .webm recording
  processing,
  onRecord,
}) {
  const [chapters, setChapters] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [videoFailed, setVideoFailed] = useState(false);
  const editTitleRef = useRef(null);
  const videoRef = useRef(null);

  // Parse chapter data from the storyboard HTML.
  useEffect(() => {
    if (!storyboardUrl) return;
    let cancelled = false;
    fetch(storyboardUrl)
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const parsed = extractChapters(doc, currentDoc);
        setChapters(parsed);
      })
      .catch(() => {
        if (!cancelled) setChapters([{ id: "ch-0", title: currentDoc || "Demo", description: "" }]);
      });
    return () => { cancelled = true; };
  }, [storyboardUrl, currentDoc]);

  function startEdit(idx) {
    const ch = chapters[idx];
    setEditingId(ch.id);
    setEditTitle(ch.title);
    setEditDesc(ch.description);
    setTimeout(() => editTitleRef.current?.focus(), 40);
  }

  function saveEdit(idx) {
    setChapters((prev) =>
      prev.map((ch, i) => i === idx ? { ...ch, title: editTitle, description: editDesc } : ch)
    );
    setEditingId(null);
  }

  function cancelEdit() { setEditingId(null); }

  function addScene() {
    const id = Math.random().toString(36).slice(2);
    setChapters((prev) => [...prev, { id, title: "", description: "" }]);
  }

  function removeScene(id) {
    setChapters((prev) => prev.length > 1 ? prev.filter((ch) => ch.id !== id) : prev);
  }

  const hasVideo = !!videoSrc && !videoFailed;

  // Reset error state when the source changes (new recording landed).
  useEffect(() => { setVideoFailed(false); }, [videoSrc]);

  return (
    <div className={`wi-storyboard${processing ? " wi-storyboard--busy" : ""}`}>
      {/* Primary editing surface: scene sidebar */}
      <aside className="wi-sb-sidebar">
        <div className="wi-sb-sidebar__head">
          <span className="wi-kicker">Scenes</span>
          <button type="button" className="wi-sb-sidebar__add" onClick={addScene} title="Add scene">+</button>
        </div>
        <div className="wi-sb-sidebar__scenes">
          {chapters.length === 0 && (
            <div className="wi-sb-sidebar__empty">No scenes detected.<br />Record to generate the storyboard.</div>
          )}
          {chapters.map((ch, i) => (
            <div
              key={ch.id}
              className={`wi-sb-scene${i === activeIdx ? " is-active" : ""}`}
              onClick={() => { setActiveIdx(i); }}
            >
              {editingId === ch.id ? (
                <div className="wi-sb-scene__edit" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={editTitleRef}
                    className="wi-sb-scene__edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Scene title"
                  />
                  <textarea
                    className="wi-sb-scene__edit-desc"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    rows={3}
                    placeholder="What happens in this scene…"
                  />
                  <div className="wi-sb-scene__edit-actions">
                    <button className="wi-btn wi-btn--primary wi-btn--xs" onClick={() => saveEdit(i)}>Save</button>
                    <button className="wi-btn wi-btn--ghost wi-btn--xs" onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="wi-sb-scene__header">
                    <span className="wi-sb-scene__n">{String(i + 1).padStart(2, "0")}</span>
                    <span className="wi-sb-scene__title">{ch.title || `Scene ${i + 1}`}</span>
                    <div className="wi-sb-scene__btns">
                      <button className="wi-sb-scene__editbtn" onClick={(e) => { e.stopPropagation(); startEdit(i); }} title="Edit" aria-label="Edit scene">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                      </button>
                      <button className="wi-sb-scene__delbtn" onClick={(e) => { e.stopPropagation(); removeScene(ch.id); }} title="Remove" aria-label="Remove scene" disabled={chapters.length === 1}>×</button>
                    </div>
                  </div>
                  <div className="wi-sb-scene__thumb-row">
                    <SceneThumb index={i} />
                  </div>
                  {ch.description && <p className="wi-sb-scene__desc">{ch.description}</p>}
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* Video player */}
      <div className="wi-sb-main">
        {hasVideo ? (
          <div className="wi-sb-player">
            <video
              ref={videoRef}
              key={videoSrc}
              controls
              className="wi-sb-video"
              preload="metadata"
              onError={() => setVideoFailed(true)}
            >
              {/* mp4 first — Safari and mobile require H.264; webm as fallback for browsers that support it */}
              <source src={videoSrc.replace(/\.webm$/, ".mp4")} type="video/mp4" />
              <source src={videoSrc} type="video/webm" />
            </video>
            <div className="wi-sb-player__meta">
              <span className="wi-kicker">{currentDoc}{viewing != null ? ` · v${viewing}` : ""}</span>
            </div>
          </div>
        ) : (
          <div className="wi-sb-norecording">
            <div className="wi-sb-norecording__icon" aria-hidden="true">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M10 8l6 4-6 4V8z" />
              </svg>
            </div>
            <h3 className="wi-sb-norecording__title">No recording yet</h3>
            <p className="wi-sb-norecording__hint">The agent will walk through the scenes and record a walkthrough. Kick it off with the button above.</p>
            {onRecord && (
              <button className="wi-btn wi-btn--primary wi-btn--lg" onClick={onRecord} disabled={processing}>
                ● Record now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function extractChapters(doc, fallbackName) {
  // Strategy 1: elements with data-chapter
  const byAttr = Array.from(doc.querySelectorAll("[data-chapter]"));
  if (byAttr.length) {
    return byAttr.map((el, i) => ({
      id: `ch-${i}`,
      title: el.getAttribute("data-chapter-title") || el.getAttribute("data-chapter") || `Scene ${i + 1}`,
      description: el.getAttribute("data-chapter-desc") || "",
    }));
  }
  // Strategy 2: section / .slide elements
  const sections = Array.from(doc.querySelectorAll("section, .slide, [data-slide]"));
  if (sections.length) {
    return sections.map((el, i) => {
      const h = el.querySelector("h1,h2,h3");
      const p = el.querySelector("p");
      return {
        id: `ch-${i}`,
        title: h?.textContent?.trim() || `Scene ${i + 1}`,
        description: (h && p) ? p.textContent?.trim().slice(0, 140) : "",
      };
    });
  }
  // Strategy 3: body h1/h2 headings
  const headings = Array.from(doc.querySelectorAll("body > h1, body > h2, main h2, article h2"));
  if (headings.length) {
    return headings.map((el, i) => ({
      id: `ch-${i}`,
      title: el.textContent?.trim() || `Scene ${i + 1}`,
      description: el.nextElementSibling?.tagName === "P" ? el.nextElementSibling.textContent?.trim().slice(0, 140) : "",
    }));
  }
  // Fallback: body h1 + first paragraph as single chapter
  const h1 = doc.querySelector("h1");
  const p = doc.querySelector("p");
  if (h1) {
    return [{ id: "ch-0", title: h1.textContent?.trim() || fallbackName, description: p?.textContent?.trim().slice(0, 140) || "" }];
  }
  return [{ id: "ch-0", title: fallbackName || "Demo", description: "" }];
}

function SceneThumb({ index }) {
  return (
    <div className="wi-sb-thumb" aria-hidden="true">
      <div className="wi-sb-thumb__nav" />
      <div className="wi-sb-thumb__page">
        <div className="wi-sb-thumb__side">
          <div className={index === 0 ? "hi" : ""} /><div /><div /><div />
        </div>
        <div className="wi-sb-thumb__main">
          <div className="wi-sb-thumb__head" />
          <div className="wi-sb-thumb__row" />
          <div className="wi-sb-thumb__row wi-sb-thumb__row--half" />
          {index % 2 === 0 && <div className="wi-sb-thumb__cards"><div /><div /><div /></div>}
        </div>
      </div>
    </div>
  );
}
