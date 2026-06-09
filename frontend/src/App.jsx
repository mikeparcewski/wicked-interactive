import { useCallback, useEffect, useRef, useState } from "react";
import Overlay from "./components/Overlay.jsx";
import InlineComment from "./components/InlineComment.jsx";
import VersionStrip from "./components/VersionStrip.jsx";
import ProcessingLock from "./components/ProcessingLock.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import SourcesPanel from "./components/SourcesPanel.jsx";
import FsPicker from "./components/FsPicker.jsx";
import NewDocModal from "./components/NewDocModal.jsx";
import NewDemoModal from "./components/NewDemoModal.jsx";
import InstallGate from "./components/InstallGate.jsx";
import { useSse } from "./hooks/useSse.js";
import { docUrl, getVersions, postFork, postExport, getConversation, listDocs, createDoc, postDemoGif, getPreflight, getSources, emitFeedback, emitChat, emitAnswer, emitSourceAttached, emitDemoRecord } from "./lib/api.js";
import { getCurrentDoc, navigateToDoc, eventsUrl, apiPath } from "./lib/apiPath.js";
import { buildItem } from "./lib/feedbackStore.js";
import { nearestReviewable, describe } from "./lib/selection.js";

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [rects, setRects] = useState({});
  const [status, setStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [procMsg, setProcMsg] = useState("");
  const [question, setQuestion] = useState(null);
  const [chat, setChat] = useState([]);                  // conversation transcript
  const [chatOpen, setChatOpen] = useState(true);        // chat panel expand/collapse
  const [docs, setDocs] = useState([]);                  // multi-doc registry (ADR-0015)
  const [showNewDoc, setShowNewDoc] = useState(false);
  const [showNewDemo, setShowNewDemo] = useState(false); // demo creation (ADR-0018)
  const [newDocError, setNewDocError] = useState(null);
  const [newDemoError, setNewDemoError] = useState(null);
  const [preflight, setPreflight] = useState(null);      // install-gate state (ADR-0016)
  const [sources, setSources] = useState([]);            // attached reference material (ADR-0017)
  const [showPicker, setShowPicker] = useState(false);
  const currentDoc = getCurrentDoc();

  const iframeRef = useRef(null);
  const pendingScroll = useRef(null);
  const viewingRef = useRef(null);
  const headRef = useRef(null);
  const isDemoRef = useRef(false);                       // demos aren't HTML-editable (ADR-0018)
  const canvasRef = useRef(null);                        // empty-state hint anchoring
  const newDocRef = useRef(null);
  const newDemoRef = useRef(null);
  const [hintY, setHintY] = useState({ doc: 40, demo: 160 });
  useEffect(() => { viewingRef.current = viewing; }, [viewing]);
  useEffect(() => { headRef.current = manifest?.head ?? null; }, [manifest]);

  const appendChat = (entry) => setChat((prev) => [...prev, entry]);

  const refreshVersions = useCallback(async () => {
    const m = await getVersions();
    setManifest(m);
    return m;
  }, []);

  const checkPreflight = useCallback(() => {
    getPreflight().then(setPreflight).catch(() => setPreflight({ ok: false, missing: [], required: {}, unreachable: true }));
  }, []);

  useEffect(() => {
    checkPreflight();
    refreshVersions().then((m) => setViewing((v) => (v == null ? m.head : v))).catch(() => {});
    getConversation().then((log) => setChat(Array.isArray(log) ? log : []));
    listDocs().then(setDocs).catch(() => setDocs([]));
    getSources().then((r) => setSources(r.sources || [])).catch(() => setSources([]));
  }, [refreshVersions, checkPreflight]);

  async function attachSources(paths, note) {
    setShowPicker(false);
    try {
      // Emit the attach intent; the source.attached frame echoes back and updates the panel.
      await emitSourceAttached(paths.map((p) => ({ path: p, note })));
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    }
  }

  async function onCreateDoc(name, html, meta) {
    setNewDocError(null);
    try {
      await createDoc(name, html, meta);
      // Empty / brainstorm docs land on the placeholder shell with the chat panel open
      // (chatOpen defaults to true on mount). The user drives content via chat from there.
      // "From my content" docs land on a placeholder too; the agent hot-swaps in the draft.
      navigateToDoc(name);   // hard-reloads to ?doc=<name>
    } catch (e) {
      setNewDocError(e.message);
    }
  }

  async function onCreateDemo(name, _html, meta) {
    setNewDemoError(null);
    try {
      await createDoc(name, "", meta);   // kind:"demo" — service seeds the storyboard placeholder
      navigateToDoc(name);               // the agent learns the app + records the first version
    } catch (e) {
      setNewDemoError(e.message);
    }
  }

  // SSE-drop backstop: re-check head on focus/visibility + every 30s. If we missed an
  // `html-updated` event during a reconnect (e.g. service restart) and we were following
  // head, catch up to the new head. Cheap and silent on no-change.
  useEffect(() => {
    let cancelled = false;
    async function catchUp() {
      if (cancelled) return;
      try {
        const before = headRef.current;
        const m = await getVersions();
        setManifest(m);
        if (m.head !== before && (viewingRef.current == null || viewingRef.current === before)) {
          pendingScroll.current = iframeRef.current?.contentWindow?.scrollY ?? 0;
          setViewing(m.head);
        }
      } catch { /* offline / transient — try again next tick */ }
    }
    const id = setInterval(catchUp, 30000);
    const onFocus = () => catchUp();
    const onVis = () => { if (!document.hidden) catchUp(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // ---- overlay rect computation (same-origin iframe) ----
  const recompute = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const next = {};
    for (const el of doc.querySelectorAll("[data-wid]")) {
      next[el.getAttribute("data-wid")] = el.getBoundingClientRect();
    }
    setRects(next);
  }, []);

  const onIframeLoad = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!win || !doc) return;
    if (pendingScroll.current != null) { win.scrollTo(0, pendingScroll.current); pendingScroll.current = null; }
    recompute();
    // Demos are a recorded video, not editable HTML — skip the highlight-to-edit wiring so
    // a click/hover on the storyboard never opens the feedback affordance (download instead).
    if (isDemoRef.current) return;
    doc.addEventListener("mousemove", (e) => {
      const el = nearestReviewable(e.target);
      setHovered(el ? el.getAttribute("data-wid") : null);
    });
    doc.addEventListener("click", (e) => {
      const el = nearestReviewable(e.target);
      if (el) { e.preventDefault(); setSelected(describe(el)); }
    });
    win.addEventListener("scroll", recompute, { passive: true });
    win.addEventListener("resize", recompute);
    // Scroll events don't bubble, but with capture:true the document-level listener
    // fires for ANY scrollable descendant (e.g. a `<section overflow-y:auto scroll-snap>`
    // deck container). Without this the overlay rects stay stale during inner-section
    // scrolls and the inline-comment dialog appears at the pre-scroll position — usually
    // way off-screen below the iframe viewport.
    doc.addEventListener("scroll", recompute, { passive: true, capture: true });
  }, [recompute]);

  // ---- Bus SSE bridge: hot-reload + lock + chat transcript (ADR-0019) ----
  // Handlers are keyed by event_type; useSse filters every frame to this doc.
  useSse(eventsUrl(), {
    "wicked.version.created": async (payload) => {
      const wasFollowing = viewingRef.current == null || viewingRef.current === headRef.current;
      const m = await refreshVersions();
      if (wasFollowing) {
        pendingScroll.current = iframeRef.current?.contentWindow?.scrollY ?? 0;
        setViewing(m.head);
      }
      // Agent-produced versions (structural edit, generated draft, demo re-record) clear the
      // working lock — the deterministic case clears on feedback.processed instead.
      if (["structural", "generated", "demo"].includes(payload.kind)) { setProcessing(false); setQuestion(null); }
    },
    "wicked.feedback.processed": (payload) => {
      setStatus(summarize(payload));
      appendChat({ role: "event", text: summarize(payload).text });
      if (payload.awaiting_structural > 0) {
        setProcMsg(`Working on it… (${payload.awaiting_structural} block${payload.awaiting_structural > 1 ? "s" : ""})`);
      } else {
        setProcessing(false);
      }
    },
    "wicked.status.posted": (payload) => {
      if (payload.message || payload.question) appendChat({ role: "agent", text: payload.question || payload.message });
      if (payload.state === "asking") {
        setQuestion({ text: payload.question, options: payload.options || [], requestId: payload.request_id });
        setProcMsg(payload.message || "A quick question");
        setProcessing(true);
      } else if (payload.state === "processing") {
        // Agent-driven redraw (e.g. from chat) — show the loading overlay on the document.
        setProcessing(true);
        if (payload.message) setProcMsg(payload.message);
      } else {
        // "working" is a non-lock progress state (demo recording, source indexing).
        if (payload.message) setProcMsg(payload.message);
        if (payload.state === "complete") { setProcessing(false); setQuestion(null); }
        if (payload.state === "error") { setProcessing(false); setStatus({ kind: "error", text: payload.message || "error" }); }
      }
    },
    "wicked.chat.posted": (payload) => appendChat({ role: payload.role || "user", text: payload.text }),
    "wicked.source.attached": (payload) => {
      setSources((prev) => {
        const known = new Set(prev.map((s) => s.path));
        const merged = [...prev];
        for (const a of (payload.added || [])) {
          if (a.path && !known.has(a.path)) { known.add(a.path); merged.push({ path: a.path, note: a.note || "", status: "pending" }); }
        }
        return merged;
      });
    },
    "wicked.source.updated": (payload) => {
      setSources((prev) => prev.map((s) => (s.path === payload.path ? { ...s, status: payload.status } : s)));
    },
    "wicked.error.raised": (payload) => {
      setProcessing(false);
      setStatus({ kind: "error", text: payload.error || "something went wrong" });
    },
  }, { docId: currentDoc });

  // ---- actions ----
  async function submitComment({ mode, text }) {
    if (!selected) return;
    let item;
    if (mode === "change-text") {
      item = buildItem({ selector: selected.selector, type: "content-edit", value: text, before: selected.before });
    } else if (mode === "section-comment") {
      item = buildItem({ selector: selected.section, type: "structural-change", instruction: text });
    } else {
      item = buildItem({ selector: selected.selector, type: "structural-change", instruction: text, before: selected.before });
    }
    setSelected(null);
    setProcessing(true);
    setProcMsg(mode === "change-text" ? "Applying…" : "Sending your comment…");
    setStatus(null);
    setQuestion(null);
    try {
      await emitFeedback([item]);   // the lock clears on feedback.processed / version.created
      if (mode !== "change-text") setProcMsg("Working on it…");
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
      setProcessing(false);
    }
  }

  async function removeBlock(selector) {
    setSelected(null);
    setProcessing(true);
    setProcMsg("Removing…");
    setStatus(null);
    try {
      await emitFeedback([buildItem({ selector, type: "remove" })]);
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
      setProcessing(false);
    }
  }

  async function sendChat(text) {
    try { await emitChat(text); } // the bridge echoes it into the transcript
    catch (e) { appendChat({ role: "event", text: `(couldn't send: ${e.message})` }); }
  }

  async function answerQuestion(answer) {
    const q = question;
    setQuestion(null);
    setProcMsg("Thanks — continuing…");
    try { await emitAnswer(q.requestId, answer); }
    catch (e) { setStatus({ kind: "error", text: e.message }); }
  }

  async function startAgainFrom(version) {
    setStatus(null);
    try { await postFork(version); } catch (e) { setStatus({ kind: "error", text: e.message }); }
  }

  async function exportAs(format) {
    if (viewing == null) return;
    setStatus({ kind: "ok", text: `Exporting v${viewing} as ${format.toUpperCase()}…` });
    try {
      const { file, download } = await postExport(viewing, format);
      // POST creates the file server-side; we then hit GET <download> via a hidden <a download>
      // so the browser saves it. Without this step the file sits in /tmp on the server and
      // never reaches the user.
      if (download) triggerDownload(download, file);
      setStatus({ kind: "ok", text: `Downloaded ${file}` });
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    }
  }

  const viewingIsHead = manifest && viewing === manifest.head;

  // "Agent is working" indicator. The transcript is append-only and the SSE round-trip is
  // sub-100ms, so deriving from the last entry beats juggling a separate timer: the moment
  // the user's message lands, the indicator lights; the moment the agent posts ANYTHING
  // (status or message), it clears. The processing lock already covers structural edits,
  // so we suppress the chat indicator while it's up to avoid double feedback.
  const lastEntry = chat[chat.length - 1];
  const agentThinking = !processing && lastEntry?.role === "user";

  const openNewDoc = () => { setNewDocError(null); setShowNewDoc(true); };
  const openNewDemo = () => { setNewDemoError(null); setShowNewDemo(true); };

  // Partition the registry by kind (ADR-0018): demos render in their own nav section.
  const docKind = (d) => (typeof d === "string" ? "doc" : d.kind || "doc");
  const demos = docs.filter((d) => docKind(d) === "demo");
  const documents = docs.filter((d) => docKind(d) !== "demo");
  const currentIsDemo = currentDoc && demos.some((d) => (typeof d === "string" ? d : d.name) === currentDoc);
  useEffect(() => { isDemoRef.current = !!currentIsDemo; }, [currentIsDemo]);

  // Anchor the launch hints to the real "New" buttons so the arrows point at the badges
  // regardless of how many docs/demos are listed (the demo button shifts as the list grows).
  useEffect(() => {
    if (currentDoc) return;
    const measure = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cTop = canvas.getBoundingClientRect().top;
      const center = (el) => (el ? el.getBoundingClientRect().top - cTop + el.getBoundingClientRect().height / 2 : null);
      const doc = center(newDocRef.current);
      const demo = center(newDemoRef.current);
      setHintY((p) => ({ doc: doc ?? p.doc, demo: demo ?? p.demo }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [currentDoc, documents.length, demos.length]);

  async function recordDemoNow() {
    setStatus({ kind: "ok", text: "Recording…" });
    try { await emitDemoRecord(); }   // status + version.created arrive over the bus bridge
    catch (e) { setStatus({ kind: "error", text: e.message }); }
  }

  const [gifBusy, setGifBusy] = useState(false);
  async function downloadGif() {
    if (viewing == null) return;
    setGifBusy(true);
    setStatus({ kind: "ok", text: `Building GIF of v${viewing}…` });
    try {
      const { download, file, bytes } = await postDemoGif(viewing);
      if (download) triggerDownload(download, `${currentDoc}-v${viewing}.gif`);
      const mb = bytes ? ` (${(bytes / 1048576).toFixed(1)} MB)` : "";
      setStatus({ kind: "ok", text: `Downloaded ${file}${mb}` });
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    } finally {
      setGifBusy(false);
    }
  }

  return (
    <div className={`wi-shell ${!chatOpen ? "wi-shell--chat-collapsed" : ""}`}>
      <header className="wi-toolbar">
        <div className="wi-toolbar__group">
          <span className="wi-logo">
            <span className="wi-logo__mark" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5l3.5 14L12 8l5.5 11L21 5" />
              </svg>
            </span>
            <span className="wi-logo__word"><b>Wicked</b> <i>Interactive</i></span>
          </span>
          {currentDoc && (
            <span className="wi-toolbar__crumb">
              <span className="wi-toolbar__docname">{currentDoc}</span>
            </span>
          )}
        </div>
        <div className="wi-toolbar__group wi-toolbar__group--center">
          <VersionStrip manifest={manifest} viewing={viewing} onView={(v) => { setViewing(v); setSelected(null); }} />
          {manifest && !viewingIsHead && (
            <button className="wi-btn wi-btn--ghost" onClick={() => startAgainFrom(viewing)}>↳ Start again from v{viewing}</button>
          )}
        </div>
        <div className="wi-toolbar__group">
          {status && currentDoc && <div className={`wi-status wi-status--${status.kind}`}>{status.text}</div>}
          {currentIsDemo && (
            <button className="wi-btn wi-btn--ghost" disabled={processing} onClick={recordDemoNow} title="Re-run the recorded walkthrough">
              ● Record
            </button>
          )}
          {currentIsDemo ? (
            <a
              className={`wi-btn wi-btn--primary wi-download${viewing == null ? " wi-download--disabled" : ""}`}
              href={viewing == null ? undefined : apiPath(`/api/demo/recording/_v${viewing}.webm`)}
              download={`${currentDoc}-v${viewing}.webm`}
              aria-disabled={viewing == null}
              title="Download the recorded walkthrough"
            >
              <span className="wi-download__icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                </svg>
              </span>
              Download video
            </a>
          ) : null}
          {currentIsDemo && (
            <button
              className="wi-btn wi-btn--ghost"
              disabled={viewing == null || gifBusy}
              onClick={downloadGif}
              title="Convert the walkthrough to an animated GIF you can embed (e.g. in a GitHub README)"
            >
              {gifBusy ? "Building GIF…" : "GIF"}
            </button>
          )}
          {!currentIsDemo && (
            <div className="wi-export" role="group" aria-label="Export">
              <span className="wi-export__icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                </svg>
              </span>
              <button className="wi-export__seg" disabled={viewing == null || processing} onClick={() => exportAs("html")}>HTML</button>
              <button className="wi-export__seg" disabled={viewing == null || processing} onClick={() => exportAs("pdf")}>PDF</button>
            </div>
          )}
        </div>
      </header>

      <nav className="wi-rail">
        <div className="wi-rail__inner">
          <RailSection
            title="Documents"
            newLabel="New document"
            onNew={openNewDoc}
            items={documents}
            currentDoc={currentDoc}
            glyph="doc"
            newRef={newDocRef}
          />
          <div className="wi-rail__sep" />
          <RailSection
            title="Demos"
            newLabel="New demo"
            onNew={openNewDemo}
            items={demos}
            currentDoc={currentDoc}
            glyph="demo"
            newRef={newDemoRef}
          />
        </div>
      </nav>

      <main className="wi-canvas" ref={canvasRef}>
        {!currentDoc && (
          <>
            <div className="wi-empty-hint" style={{ top: Math.max(4, hintY.doc - 22) }} aria-hidden="true">
              <svg className="wi-empty-hint__arrow" width="86" height="44" viewBox="0 0 86 44" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M82 11C56 13 27 15 7 22" />
                <path d="M7 22C13 19 18 16 22 12" />
                <path d="M7 22C13 25 18 30 22 34" />
              </svg>
              <span className="wi-empty-hint__text">start a new document</span>
            </div>
            <div className="wi-empty-hint" style={{ top: Math.max(4, hintY.demo - 22) }} aria-hidden="true">
              <svg className="wi-empty-hint__arrow" width="86" height="44" viewBox="0 0 86 44" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M82 11C56 13 27 15 7 22" />
                <path d="M7 22C13 19 18 16 22 12" />
                <path d="M7 22C13 25 18 30 22 34" />
              </svg>
              <span className="wi-empty-hint__text">…or record a demo of your app</span>
            </div>
          </>
        )}
        <div className={`wi-doc ${processing ? "wi-doc--busy" : ""}`}>
          <iframe ref={iframeRef} title="document" src={viewing == null ? "about:blank" : docUrl(viewing)} onLoad={onIframeLoad} />
          {!currentIsDemo && (
            <>
              <Overlay rects={rects} pending={EMPTY} hovered={hovered} selected={selected?.selector} onRemove={removeBlock} />
              <InlineComment selected={selected} rect={selected ? rects[selected.selector] : null} onSubmit={submitComment} onCancel={() => setSelected(null)} />
            </>
          )}
          <ProcessingLock active={processing} message={procMsg} question={question?.text} options={question?.options}
            onAnswer={answerQuestion} onDismiss={() => { setProcessing(false); setQuestion(null); }} />
        </div>
      </main>

      <div className="wi-side">
        <SourcesPanel sources={sources} onAdd={() => setShowPicker(true)} narrow={!chatOpen} onExpand={() => setChatOpen(true)} />
        <ChatPanel log={chat} onSend={sendChat} busy={processing} agentThinking={agentThinking} collapsed={!chatOpen} onToggle={() => setChatOpen((o) => !o)} />
      </div>

      <FsPicker open={showPicker} onAdd={attachSources} onCancel={() => setShowPicker(false)} />

      <NewDocModal
        open={showNewDoc}
        error={newDocError}
        onCreate={onCreateDoc}
        onCancel={() => setShowNewDoc(false)}
      />

      <NewDemoModal
        open={showNewDemo}
        error={newDemoError}
        onCreate={onCreateDemo}
        onCancel={() => setShowNewDemo(false)}
      />

      <InstallGate preflight={preflight} onRetry={checkPreflight} />
    </div>
  );
}

const EMPTY = new Set();

const RAIL_GLYPHS = {
  doc: <path d="M12 5v14M5 12h14" />,                                   // plus
  demo: <path d="M8 5v14l11-7z" />,                                    // play triangle
};

/** One labelled nav section: a "New …" action row + a kind-filtered list of entries. */
function RailSection({ title, newLabel, onNew, items, currentDoc, glyph, newRef }) {
  return (
    <div className="wi-rail__section">
      <button ref={newRef} className="wi-rail__row wi-rail__new-row" title={newLabel} onClick={onNew}>
        <span className="wi-rail__new" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {RAIL_GLYPHS[glyph] || RAIL_GLYPHS.doc}
          </svg>
        </span>
        <span className="wi-rail__label wi-rail__new-label">{newLabel}</span>
      </button>
      <div className="wi-rail__heading"><span className="wi-rail__label">{title}</span></div>
      <div className="wi-rail__docs">
        {items.length === 0
          ? <div className="wi-rail__empty"><span className="wi-rail__label">None yet</span></div>
          : items.map((d) => {
              const name = typeof d === "string" ? d : d.name;
              return (
                <button
                  key={name}
                  className={`wi-rail__doc ${name === currentDoc ? "is-active" : ""}`}
                  title={name}
                  onClick={() => navigateToDoc(name)}
                >
                  <span className="wi-rail__doc-glyph">{name.slice(0, 1).toUpperCase()}</span>
                  <span className="wi-rail__label">{name}</span>
                </button>
              );
            })}
      </div>
    </div>
  );
}

/** Trigger a browser download for a same-origin URL with an explicit filename. */
function triggerDownload(url, filename) {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function summarize(data) {
  const parts = [];
  if (data.applied?.length) parts.push(`${data.applied.length} applied`);
  if (data.stale?.length) parts.push(`${data.stale.length} stale`);
  if (data.rejected?.length) parts.push(`${data.rejected.length} rejected`);
  const kind = data.rejected?.length ? "warn" : "ok";
  return { kind, text: `v${data.version}: ${parts.join(", ") || "no changes"}` };
}
