// DemoStoryboard.jsx — video-player view for demo docs.
//
// Layout: full-width video (top) + horizontal filmstrip thumbnail panel (bottom).
import { useCallback, useEffect, useRef, useState } from "react";

export default function DemoStoryboard({
  currentDoc,
  viewing,
  storyboardUrl,
  videoSrc,    // webm URL; mp4 derived by replacing extension
  posterSrc,   // poster thumbnail URL
  processing,
  onRecord,
}) {
  const [chapters, setChapters] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);
  const editTitleRef = useRef(null);

  useEffect(() => { setPlaying(false); }, [videoSrc]);

  function handlePlayBtn() {
    videoRef.current?.play();
    setPlaying(true);
  }

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

  function startEdit(id, title, desc, e) {
    e?.stopPropagation();
    setEditingId(id);
    setEditTitle(title);
    setEditDesc(desc);
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

  function removeScene(id, e) {
    e?.stopPropagation();
    setChapters((prev) => prev.length > 1 ? prev.filter((ch) => ch.id !== id) : prev);
  }

  const hasVideo = !!videoSrc;

  return (
    <div className={`wi-storyboard${processing ? " wi-storyboard--busy" : ""}`}>

      {/* Full-width video player */}
      <div className="wi-sb-main">
        {hasVideo ? (
          <div className="wi-sb-player">
            <div className="wi-sb-video-wrap">
              <video
                ref={videoRef}
                key={videoSrc}
                controls
                className="wi-sb-video"
                poster={posterSrc}
                preload="metadata"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              >
                <source src={videoSrc.replace(/\.webm$/, ".mp4")} type="video/mp4" />
                <source src={videoSrc} type="video/webm" />
              </video>
              {!playing && (
                <button className="wi-sb-playbtn" onClick={handlePlayBtn} aria-label="Play recording">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                </button>
              )}
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
            <p className="wi-sb-norecording__hint">The agent will walk through the scenes and record a walkthrough.</p>
            {onRecord && (
              <button className="wi-btn wi-btn--primary wi-btn--lg" onClick={onRecord} disabled={processing}>
                ● Record now
              </button>
            )}
          </div>
        )}
      </div>

      {/* Horizontal filmstrip thumbnail panel */}
      <div className="wi-sb-filmstrip">
        <div className="wi-sb-filmstrip__scroll">
          {chapters.map((ch, i) => (
            <div
              key={ch.id}
              className={`wi-sb-fcard${i === activeIdx ? " is-active" : ""}`}
              onClick={() => setActiveIdx(i)}
            >
              {editingId === ch.id ? (
                <div className="wi-sb-fcard__edit" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={editTitleRef}
                    className="wi-sb-fcard__edit-input"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Scene title"
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(i); if (e.key === "Escape") cancelEdit(); }}
                  />
                  <div className="wi-sb-fcard__edit-row">
                    <button className="wi-btn wi-btn--primary wi-btn--xs" onClick={() => saveEdit(i)}>Save</button>
                    <button className="wi-btn wi-btn--ghost wi-btn--xs" onClick={cancelEdit}>×</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="wi-sb-fcard__thumb">
                    <SceneThumb index={i} />
                    <span className="wi-sb-fcard__n">{String(i + 1).padStart(2, "0")}</span>
                    <div className="wi-sb-fcard__actions">
                      <button
                        className="wi-sb-fcard__editbtn"
                        onClick={(e) => startEdit(ch.id, ch.title, ch.description, e)}
                        title="Edit"
                        aria-label="Edit scene"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        className="wi-sb-fcard__delbtn"
                        onClick={(e) => removeScene(ch.id, e)}
                        title="Remove"
                        aria-label="Remove scene"
                        disabled={chapters.length === 1}
                      >×</button>
                    </div>
                  </div>
                  <span className="wi-sb-fcard__title">{ch.title || `Scene ${i + 1}`}</span>
                </>
              )}
            </div>
          ))}

          {/* Add scene button */}
          <button className="wi-sb-fcard wi-sb-fcard--add" onClick={addScene} title="Add scene">
            <span className="wi-sb-fcard__add-icon">+</span>
            <span className="wi-sb-fcard__title">Add scene</span>
          </button>
        </div>

        {/* Version kicker */}
        <div className="wi-sb-filmstrip__meta">
          {currentDoc}{viewing != null ? ` · v${viewing}` : ""}
        </div>
      </div>
    </div>
  );
}

function extractChapters(doc, fallbackName) {
  const byAttr = Array.from(doc.querySelectorAll("[data-chapter]"));
  if (byAttr.length) {
    return byAttr.map((el, i) => ({
      id: `ch-${i}`,
      title: el.getAttribute("data-chapter-title") || el.getAttribute("data-chapter") || `Scene ${i + 1}`,
      description: el.getAttribute("data-chapter-desc") || "",
    }));
  }
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
  const headings = Array.from(doc.querySelectorAll("body > h1, body > h2, main h2, article h2"));
  if (headings.length) {
    return headings.map((el, i) => ({
      id: `ch-${i}`,
      title: el.textContent?.trim() || `Scene ${i + 1}`,
      description: el.nextElementSibling?.tagName === "P" ? el.nextElementSibling.textContent?.trim().slice(0, 140) : "",
    }));
  }
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
