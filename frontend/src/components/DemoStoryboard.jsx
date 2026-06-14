// DemoStoryboard.jsx — video-player view for demo docs.
//
// Layout (3-zone):
//   LEFT:   vertical chapter list (click to seek) + "Add scene" button
//   RIGHT:  flex column — full-width video (top) + real-screenshot filmstrip (bottom)
import { useEffect, useRef, useState } from "react";
import AddSceneModal from "./AddSceneModal.jsx";

export default function DemoStoryboard({
  currentDoc,
  viewing,
  storyboardUrl,
  videoSrc,
  posterSrc,
  processing,
  onRecord,
  onAddScene,
}) {
  const [chapters, setChapters] = useState([]);
  const [activeIdx, setActiveIdx] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [showAddScene, setShowAddScene] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => { setPlaying(false); setActiveIdx(null); }, [videoSrc]);

  function handlePlayBtn() {
    videoRef.current?.play();
    setPlaying(true);
  }

  function seekTo(ch, i) {
    setActiveIdx(i);
    if (videoRef.current && ch.at != null) {
      videoRef.current.currentTime = ch.at;
      videoRef.current.play().catch(() => {});
      setPlaying(true);
    }
  }

  useEffect(() => {
    if (!storyboardUrl) return;
    let cancelled = false;
    fetch(storyboardUrl)
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        setChapters(extractChapters(doc, currentDoc));
      })
      .catch(() => { if (!cancelled) setChapters([]); });
    return () => { cancelled = true; };
  }, [storyboardUrl, currentDoc]);

  function handleAddScene(req) {
    setShowAddScene(false);
    onAddScene?.(req);
  }

  const hasVideo = !!videoSrc;

  return (
    <div className={`wi-storyboard${processing ? " wi-storyboard--busy" : ""}`}>
      <AddSceneModal
        open={showAddScene}
        onSubmit={handleAddScene}
        onCancel={() => setShowAddScene(false)}
      />

      {/* Left: chapter list */}
      <aside className="wi-sb-chapters">
        <div className="wi-sb-chapters__head">
          <span className="wi-kicker">Scenes</span>
          <button className="wi-sb-add-scene" onClick={() => setShowAddScene(true)}>
            <i className="wi-sb-add-scene__icon">+</i>
            Add a scene
          </button>
        </div>
        <div className="wi-sb-chapters__list">
          {chapters.length === 0 && (
            <p className="wi-sb-chapters__empty">Record to generate scenes.</p>
          )}
          {chapters.map((ch, i) => (
            <button
              key={ch.id}
              className={`wi-sb-chitem${activeIdx === i ? " is-active" : ""}`}
              onClick={() => seekTo(ch, i)}
            >
              <div className="wi-sb-chitem__thumb">
                {ch.thumb
                  ? <img src={ch.thumb} alt="" className="wi-sb-chitem__img" />
                  : <SceneThumb index={i} />
                }
                {ch.badge && <span className="wi-sb-chitem__badge">{ch.badge}</span>}
              </div>
              <div className="wi-sb-chitem__info">
                <span className="wi-sb-chitem__n">{String(i + 1).padStart(2, "0")}</span>
                <span className="wi-sb-chitem__title">{ch.title || `Scene ${i + 1}`}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* Right: video + filmstrip */}
      <div className="wi-sb-right">
        {/* Video */}
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

      </div>
    </div>
  );
}

function extractChapters(doc, fallbackName) {
  // Primary: real step chapters with timestamps + screenshots
  const buttons = Array.from(doc.querySelectorAll(".wi-demo__chapter[data-seek]"));
  if (buttons.length) {
    return buttons.map((btn, i) => ({
      id: `ch-${i}`,
      at: parseFloat(btn.getAttribute("data-seek")) || 0,
      title: btn.querySelector(".wi-demo__name")?.textContent?.trim() || `Scene ${i + 1}`,
      badge: btn.querySelector(".wi-demo__badge")?.textContent?.trim() || "",
      thumb: btn.querySelector("img")?.getAttribute("src") || null,
    }));
  }
  // Fallback: heading-based chapters (no timestamps)
  const headings = Array.from(doc.querySelectorAll("body > h1, body > h2, main h2, article h2, section h2"));
  if (headings.length) {
    return headings.map((el, i) => ({
      id: `ch-${i}`, at: null, thumb: null, badge: "",
      title: el.textContent?.trim() || `Scene ${i + 1}`,
    }));
  }
  const h1 = doc.querySelector("h1");
  if (h1) {
    return [{ id: "ch-0", at: null, thumb: null, badge: "", title: h1.textContent?.trim() || fallbackName }];
  }
  return [];
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
