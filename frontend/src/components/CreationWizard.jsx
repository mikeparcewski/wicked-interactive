// CreationWizard.jsx — unified in-canvas creation flow for Interactive docs and Demo Videos.
//
// Two paths, each with their own step sequence:
//   Interactive: choose style (web/pdf) → name + brief → create
//   Demo Video:  name + url + brief → scene outline → transitions → recording mode → create
//
// Renders inside the canvas (not a modal) when open=true. The caller decides where to mount it.
import { useEffect, useRef, useState } from "react";

const TRANSITION_PRESETS = [
  { id: "dark",    label: "Dark",    bg: "#1a1a1b", fg: "#ffffff" },
  { id: "light",   label: "Light",   bg: "#faf7ec", fg: "#232324" },
  { id: "accent",  label: "Accent",  bg: "#ffda19", fg: "#1a1a1b" },
  { id: "branded", label: "Brand",   bg: "#2a566e", fg: "#ffffff" },
];

function emptyScene() {
  return { id: Math.random().toString(36).slice(2), title: "", description: "" };
}


const FORMAT_OPTIONS = [
  { id: "web",      label: "Web",      desc: "Scrollable HTML — animations, interactivity, and rich UX." },
  { id: "ppt",      label: "PPT",      desc: "Fixed landscape slides — no interactives, exports as PPTX." },
  { id: "brochure", label: "Brochure", desc: "Portrait PDF — stylized pages, print-ready layout." },
  { id: "doc",      label: "Doc",      desc: "Minimal formatting — content-first, easy to read and share." },
];

export default function CreationWizard({ open, initialPath, initialBrief, sourcePaths = [], onBrowseSources, onRemoveSource, onCreateDoc, onCreateDemo, onCancel, docError, demoError }) {
  const [path, setPath] = useState(null);          // null | "interactive" | "demo"
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [style, setStyle] = useState("web");
  const [url, setUrl] = useState("");
  const [scenes, setScenes] = useState([emptyScene()]);
  const [transPreset, setTransPreset] = useState("dark");
  const [customBg, setCustomBg] = useState("#1a1a1b");
  const [customFg, setCustomFg] = useState("#ffffff");
  const [customColors, setCustomColors] = useState(false);
  const [recordingMode, setRecordingMode] = useState("continuous");
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const p = initialPath || null;
    setPath(p);
    setStep(p ? 1 : 0);
    setName("");
    setBrief((initialBrief || "").trim());
    setStyle("web");
    setUrl("");
    setScenes([emptyScene()]);
    setTransPreset("dark");
    setCustomBg("#1a1a1b");
    setCustomFg("#ffffff");
    setCustomColors(false);
    setRecordingMode("continuous");
  }, [open, initialPath, initialBrief]);

  // Focus the name input when the first real step appears.
  useEffect(() => {
    if (open && step === 1 && path) {
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open, step, path]);

  if (!open) return null;

  // ---- path choice ----
  function choosePath(p) {
    setPath(p);
    setStep(1);
  }

  // ---- scenes management ----
  const updateScene = (id, key, val) =>
    setScenes((prev) => prev.map((s) => (s.id === id ? { ...s, [key]: val } : s)));
  const addScene = () => setScenes((prev) => [...prev, emptyScene()]);
  const removeScene = (id) => setScenes((prev) => prev.length > 1 ? prev.filter((s) => s.id !== id) : prev);
  const moveScene = (id, dir) =>
    setScenes((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });

  // ---- URL validation ----
  let urlOk = false;
  try { const u = new URL(url.trim()); urlOk = u.protocol === "http:" || u.protocol === "https:"; } catch { urlOk = false; }

  // ---- submit ----
  function submitInteractive(e) {
    e.preventDefault();
    const trimName = name.trim();
    const trimBrief = brief.trim();
    if (!trimName) return;
    const hasSources = sourcePaths.length > 0;
    const kind = (trimBrief || hasSources) ? "source" : "blank";
    onCreateDoc(trimName, "", { kind, brief: trimBrief, style, sourcePaths: hasSources ? sourcePaths : undefined });
  }

  function submitDemo(e) {
    e.preventDefault();
    const trimName = name.trim();
    if (!trimName || !urlOk) return;
    const preset = TRANSITION_PRESETS.find((p) => p.id === transPreset) || TRANSITION_PRESETS[0];
    const transitions = customColors
      ? { preset: "custom", bg: customBg, fg: customFg }
      : { preset: preset.id, bg: preset.bg, fg: preset.fg };
    const filteredScenes = scenes.filter((s) => s.title.trim() || s.description.trim());
    onCreateDemo(trimName, "", {
      kind: "demo",
      url: url.trim(),
      brief: brief.trim(),
      scenes: filteredScenes,
      transitions,
      recordingMode,
    });
  }

  // ---- step navigation ----
  const DEMO_STEPS = 4; // setup, scenes, transitions, mode
  const canAdvanceDemoStep1 = name.trim().length > 0 && urlOk;

  // ---- render ----
  const isDemo = path === "demo";
  const isInteractive = path === "interactive";

  if (!path) {
    return (
      <div className="wi-wizard">
        <div className="wi-wizard__inner">
          <header className="wi-wizard__hdr">
            <span className="wi-kicker">New</span>
            <h2 className="wi-wizard__title">What are you building?</h2>
            <button className="wi-wizard__cancel" onClick={onCancel} aria-label="Cancel">×</button>
          </header>
          <div className="wi-wiz-choice">
            <button className="wi-wiz-choice__card" onClick={() => choosePath("interactive")}>
              <span className="wi-wiz-choice__icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5M9 13h6M9 17h4" />
                </svg>
              </span>
              <strong className="wi-wiz-choice__label">Interactive</strong>
              <span className="wi-wiz-choice__sub">A live HTML document you can click to edit — present it, export it as PDF or PPTX, or embed it anywhere.</span>
            </button>
            <button className="wi-wiz-choice__card" onClick={() => choosePath("demo")}>
              <span className="wi-wiz-choice__icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M10 8l6 4-6 4V8z" />
                </svg>
              </span>
              <strong className="wi-wiz-choice__label">Demo Video</strong>
              <span className="wi-wiz-choice__sub">A recorded walkthrough of a live app — scene-by-scene, exported as video or GIF.</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Interactive path ----
  if (isInteractive) {
    return (
      <div className="wi-wizard">
        <div className="wi-wizard__inner">
          <header className="wi-wizard__hdr">
            <button className="wi-wizard__back" onClick={() => setPath(null)} aria-label="Back to choice">←</button>
            <div>
              <span className="wi-kicker">Interactive</span>
              <h2 className="wi-wizard__title">New document</h2>
            </div>
            <button className="wi-wizard__cancel" onClick={onCancel} aria-label="Cancel">×</button>
          </header>

          <form className="wi-wizard__form" onSubmit={submitInteractive}>
            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">Name</label>
              <input
                ref={nameRef}
                className="wi-wiz-field__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-presentation"
                spellCheck={false}
              />
              <span className="wi-wiz-field__hint">Lowercase letters, digits, hyphens.</span>
            </div>

            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">Output format</label>
              <div className="wi-wiz-format-grid">
                {FORMAT_OPTIONS.map(({ id, label, desc }) => (
                  <button
                    key={id}
                    type="button"
                    className={`wi-wiz-format-card${style === id ? " is-on" : ""}`}
                    onClick={() => setStyle(id)}
                  >
                    <strong>{label}</strong>
                    <span>{desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">What should it become? <span className="wi-wiz-field__opt">optional</span></label>
              <textarea
                className="wi-wiz-field__textarea"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={3}
                placeholder="A 6-slide investor update — lead with the ARR chart, keep it punchy."
              />
              <span className="wi-wiz-field__hint">Leave blank to start with an empty doc and build it in the chat.</span>
            </div>

            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">Ground it in your content <span className="wi-wiz-field__opt">optional</span></label>
              {sourcePaths.length > 0 && (
                <ul className="wi-wiz-sources">
                  {sourcePaths.map((p) => (
                    <li key={p} className="wi-wiz-source">
                      <span className="wi-wiz-source__path" title={p}>{p.split(/[\\/]/).pop() || p}</span>
                      <button type="button" className="wi-wiz-source__del" onClick={() => onRemoveSource(p)} title="Remove" aria-label="Remove source">×</button>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="wi-wiz-add-source" onClick={onBrowseSources}>
                + Add files or folders
              </button>
              <span className="wi-wiz-field__hint">Files stay on your machine — the agent reads them to ground the document in real content.</span>
            </div>

            {docError && <div className="wi-wiz-error">{docError}</div>}

            <div className="wi-wizard__actions">
              <button type="submit" className="wi-btn wi-btn--primary wi-btn--lg" disabled={!name.trim()}>
                {(brief.trim() || sourcePaths.length > 0) ? "Generate document" : "Create blank document"}
              </button>
              <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ---- Demo path ----
  const demoStepTitles = ["", "Set up your demo", "Outline the scenes", "Transition style", "Recording mode"];
  const preset = TRANSITION_PRESETS.find((p) => p.id === transPreset) || TRANSITION_PRESETS[0];
  const previewBg = customColors ? customBg : preset.bg;
  const previewFg = customColors ? customFg : preset.fg;

  return (
    <div className="wi-wizard">
      <div className="wi-wizard__inner">
        <header className="wi-wizard__hdr">
          <button className="wi-wizard__back" onClick={() => { if (step === 1) setPath(null); else setStep((s) => s - 1); }} aria-label="Back">←</button>
          <div>
            <span className="wi-kicker">Demo Video · Step {step} of {DEMO_STEPS}</span>
            <h2 className="wi-wizard__title">{demoStepTitles[step]}</h2>
          </div>
          <button className="wi-wizard__cancel" onClick={onCancel} aria-label="Cancel">×</button>
        </header>

        <div className="wi-wizard__progress">
          {Array.from({ length: DEMO_STEPS }, (_, i) => (
            <div key={i} className={`wi-wizard__pip${i + 1 <= step ? " is-done" : ""}`} />
          ))}
        </div>

        {step === 1 && (
          <form className="wi-wizard__form" onSubmit={(e) => {
            e.preventDefault();
            if (!canAdvanceDemoStep1) return;
            setStep(2);
          }}>
            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">Demo name</label>
              <input
                ref={nameRef}
                className="wi-wiz-field__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="checkout-flow"
                spellCheck={false}
              />
            </div>

            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">App URL</label>
              <input
                className="wi-wiz-field__input wi-wiz-field__input--mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://staging.example.com"
                spellCheck={false}
              />
              {url.trim() && !urlOk && <span className="wi-wiz-field__hint wi-wiz-field__hint--err">Enter a full http(s) URL.</span>}
            </div>

            <div className="wi-wiz-field">
              <label className="wi-wiz-field__label">What should the demo show? <span className="wi-wiz-field__opt">optional</span></label>
              <textarea
                className="wi-wiz-field__textarea"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={3}
                placeholder="Sign in, add the Pro plan to cart, and walk through checkout."
              />
            </div>

            {demoError && <div className="wi-wiz-error">{demoError}</div>}

            <div className="wi-wizard__actions">
              <button type="submit" className="wi-btn wi-btn--primary wi-btn--lg" disabled={!canAdvanceDemoStep1}>
                Next: outline scenes →
              </button>
              <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div className="wi-wizard__form">
            {brief.trim() && (
              <div className="wi-wiz-brief-recap">
                <span className="wi-wiz-brief-recap__label">Your brief</span>
                <p className="wi-wiz-brief-recap__text">{brief.trim()}</p>
              </div>
            )}
            <p className="wi-wiz-intro">
              The agent will read your brief and break it into scenes. Add scenes below only if you want to guide the order or name specific steps — otherwise skip and let it decide.
            </p>
            <div className="wi-wiz-scenes">
              {scenes.map((scene, i) => (
                <div key={scene.id} className="wi-wiz-scene">
                  <div className="wi-wiz-scene__num">{i + 1}</div>
                  <div className="wi-wiz-scene__body">
                    <input
                      className="wi-wiz-scene__title"
                      value={scene.title}
                      onChange={(e) => updateScene(scene.id, "title", e.target.value)}
                      placeholder={`Scene ${i + 1} — e.g. Sign in`}
                    />
                    <textarea
                      className="wi-wiz-scene__desc"
                      value={scene.description}
                      onChange={(e) => updateScene(scene.id, "description", e.target.value)}
                      rows={2}
                      placeholder="What happens in this scene…"
                    />
                  </div>
                  <div className="wi-wiz-scene__actions">
                    <button type="button" className="wi-wiz-scene__btn" onClick={() => moveScene(scene.id, -1)} disabled={i === 0} title="Move up" aria-label="Move up">↑</button>
                    <button type="button" className="wi-wiz-scene__btn" onClick={() => moveScene(scene.id, 1)} disabled={i === scenes.length - 1} title="Move down" aria-label="Move down">↓</button>
                    <button type="button" className="wi-wiz-scene__btn wi-wiz-scene__btn--del" onClick={() => removeScene(scene.id)} disabled={scenes.length === 1} title="Remove scene" aria-label="Remove">×</button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="wi-wiz-add-scene" onClick={addScene}>+ Add scene</button>
            <div className="wi-wizard__actions">
              <button type="button" className="wi-btn wi-btn--primary wi-btn--lg" onClick={() => setStep(3)}>
                {scenes.some((s) => s.title.trim()) ? "Next: transitions →" : "Skip — agent decides →"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wi-wizard__form">
            <p className="wi-wiz-intro">
              Choose how the text overlay looks between scenes — the background and text color for title cards.
            </p>
            <div className="wi-wiz-transitions">
              {TRANSITION_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`wi-wiz-trans__preset${transPreset === p.id && !customColors ? " is-on" : ""}`}
                  style={{ "--trans-bg": p.bg, "--trans-fg": p.fg }}
                  onClick={() => { setTransPreset(p.id); setCustomColors(false); }}
                  aria-pressed={transPreset === p.id && !customColors}
                >
                  <span className="wi-wiz-trans__swatch">
                    <span className="wi-wiz-trans__label-preview" style={{ color: p.fg }}>Aa</span>
                  </span>
                  <span className="wi-wiz-trans__name">{p.label}</span>
                </button>
              ))}
              <button
                type="button"
                className={`wi-wiz-trans__preset wi-wiz-trans__preset--custom${customColors ? " is-on" : ""}`}
                onClick={() => setCustomColors(true)}
                aria-pressed={customColors}
              >
                <span className="wi-wiz-trans__swatch wi-wiz-trans__swatch--custom">
                  <span style={{ color: customFg }}>Aa</span>
                </span>
                <span className="wi-wiz-trans__name">Custom</span>
              </button>
            </div>

            {customColors && (
              <div className="wi-wiz-custom-colors">
                <label className="wi-wiz-cc__field">
                  <span>Background</span>
                  <div className="wi-wiz-cc__row">
                    <input type="color" value={customBg} onChange={(e) => setCustomBg(e.target.value)} />
                    <input className="wi-wiz-cc__hex" value={customBg} onChange={(e) => setCustomBg(e.target.value)} spellCheck={false} />
                  </div>
                </label>
                <label className="wi-wiz-cc__field">
                  <span>Text</span>
                  <div className="wi-wiz-cc__row">
                    <input type="color" value={customFg} onChange={(e) => setCustomFg(e.target.value)} />
                    <input className="wi-wiz-cc__hex" value={customFg} onChange={(e) => setCustomFg(e.target.value)} spellCheck={false} />
                  </div>
                </label>
              </div>
            )}

            <div className="wi-wiz-trans__preview" style={{ backgroundColor: previewBg, color: previewFg }}>
              <span className="wi-wiz-trans__preview-title">Scene title</span>
              <span className="wi-wiz-trans__preview-sub">A brief description of what you'll see next.</span>
            </div>

            <div className="wi-wizard__actions">
              <button type="button" className="wi-btn wi-btn--primary wi-btn--lg" onClick={() => setStep(4)}>Next: recording mode →</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="wi-wizard__form">
            <p className="wi-wiz-intro">
              How do you want to record the demo?
            </p>
            <div className="wi-wiz-recmodes">
              <button
                type="button"
                className={`wi-wiz-recmode${recordingMode === "continuous" ? " is-on" : ""}`}
                onClick={() => setRecordingMode("continuous")}
                aria-pressed={recordingMode === "continuous"}
              >
                <span className="wi-wiz-recmode__icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M10 8l6 4-6 4V8z" />
                  </svg>
                </span>
                <div className="wi-wiz-recmode__body">
                  <strong>Continuous <span className="wi-wiz-recmode__rec">Recommended</span></strong>
                  <span>The agent walks through all scenes in one shot — the fastest way to get a clean recording.</span>
                </div>
              </button>
              <button
                type="button"
                className={`wi-wiz-recmode${recordingMode === "scene-by-scene" ? " is-on" : ""}`}
                onClick={() => setRecordingMode("scene-by-scene")}
                aria-pressed={recordingMode === "scene-by-scene"}
              >
                <span className="wi-wiz-recmode__icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="6" width="5" height="12" rx="1" />
                    <rect x="9" y="6" width="5" height="12" rx="1" />
                    <rect x="16" y="6" width="6" height="12" rx="1" />
                  </svg>
                </span>
                <div className="wi-wiz-recmode__body">
                  <strong>Scene-by-scene</strong>
                  <span>Record each scene individually and reorder them after — great if you need to reshoot specific parts.</span>
                </div>
              </button>
            </div>

            {demoError && <div className="wi-wiz-error">{demoError}</div>}

            <div className="wi-wizard__actions">
              <button type="button" className="wi-btn wi-btn--primary wi-btn--lg" onClick={submitDemo}>
                Create demo &amp; record
              </button>
              <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
