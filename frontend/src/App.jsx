import { useCallback, useEffect, useRef, useState } from "react";
import Overlay from "./components/Overlay.jsx";
import InlineComment from "./components/InlineComment.jsx";
import VersionStrip from "./components/VersionStrip.jsx";
import Composer from "./components/Composer.jsx";
import Thread from "./components/Thread.jsx";
import ToolRail, { REVIEW_LABEL } from "./components/ToolRail.jsx";
import ProjectSwitcher from "./components/ProjectSwitcher.jsx";
import FsPicker from "./components/FsPicker.jsx";
import CreationWizard from "./components/CreationWizard.jsx";
import DemoStoryboard from "./components/DemoStoryboard.jsx";
import ThemeFromUrlModal from "./components/ThemeFromUrlModal.jsx";
import InstallGate from "./components/InstallGate.jsx";
import { useSse } from "./hooks/useSse.js";
import { docUrl, getVersions, postFork, postExport, getConversation, listDocs, createDoc, postDemoGif, getPreflight, getSources, emitFeedback, emitChat, emitAnswer, emitSourceAttached, emitSourceRemoved, emitDemoRecord, emitThemeFromUrl, emitThemeFromFile, emitReviewRequested, emitStatusRequested, getProjects } from "./lib/api.js";
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
  const [sideOpen, setSideOpen] = useState(() => {       // sidebar: open on first session, then collapsed (hover-expands)
    try { return !localStorage.getItem("wi-side-seen"); } catch { return true; }
  });
  const [sideHover, setSideHover] = useState(false);     // JS hover-expand — so an explicit collapse isn't instantly re-expanded by the lingering pointer
  const sideSuppressRef = useRef(false);                 // set on collapse; blocks hover-expand until the pointer leaves + re-enters
  // Initialize from sessionStorage so the working state is set on the very first paint —
  // no flash of "idle" before the async getConversation effect fires (ADR-0024).
  const [threadOpen, setThreadOpen] = useState(() => {
    try { const g = sessionStorage.getItem("wi-generating"); const d = getCurrentDoc(); return !!(g && d && g === d); } catch { return false; }
  });
  const [docs, setDocs] = useState([]);                  // multi-doc registry (ADR-0015)
  const [showWizard, setShowWizard] = useState(false);    // unified creation wizard
  const [wizardPath, setWizardPath] = useState(null);    // pre-select "interactive" | "demo" | null
  const [projects, setProjects] = useState([]);          // other running instances for the project switcher
  const [projectRoot, setProjectRoot] = useState(null);  // this instance's docs root (shown when expanded)
  const [demoMode, setDemoMode] = useState(false);       // composer mode: false = Interactive, true = Demo recording (toggle lives in the top nav)
  const [showThemeUrl, setShowThemeUrl] = useState(false); // learn-a-theme-from-a-URL (ADR-0020)
  const [wizardDocError, setWizardDocError] = useState(null);
  const [wizardDemoError, setWizardDemoError] = useState(null);
  const [newDocBrief, setNewDocBrief] = useState("");    // seeded when the launch-state chat starts a doc
  const [themeUrlError, setThemeUrlError] = useState(null);
  const [preflight, setPreflight] = useState(null);      // install-gate state (ADR-0016)
  const [sources, setSources] = useState([]);            // attached reference material (ADR-0017)
  const [showPicker, setShowPicker] = useState(false);
  const [pickMode, setPickMode] = useState("sources");   // FsPicker routes results: "sources" | "theme"
  const [reviewInFlight, setReviewInFlight] = useState({}); // per-reviewer in-flight: { match:true } — reviews run NON-BLOCKING + CONCURRENT, never veil the canvas
  const [agentBusy, setAgentBusy] = useState(() => {
    try { const g = sessionStorage.getItem("wi-generating"); const d = getCurrentDoc(); return !!(g && d && g === d); } catch { return false; }
  });
  const [renderReady, setRenderReady] = useState(false); // a new version landed — console may close
  const [consoleEscape, setConsoleEscape] = useState(false); // safety: allow closing a hung console
  const [realStatusAt, setRealStatusAt] = useState(0);   // bumps when a REAL agent status lands — resets the whimsy filler so it never talks over a fresh update
  // Theme: class-driven on <html> (the pre-paint script in index.html sets the initial
  // class from localStorage || prefers-color-scheme before first paint). This state just
  // mirrors it so the toggle button shows the right glyph and persists the user's choice.
  const [theme, setTheme] = useState(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.classList.toggle("dark", next === "dark");
        document.documentElement.dataset.wiTheme = next;
        try { localStorage.setItem("wi-theme", next); } catch { /* private mode — session-only */ }
      }
      return next;
    });
  }, []);
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
  // Mark the sidebar "seen" so it only auto-opens on the very first session; later loads
  // start collapsed and expand on hover (ADR: ChatGPT-style rail).
  useEffect(() => { try { localStorage.setItem("wi-side-seen", "1"); } catch { /* private mode */ } }, []);

  const appendChat = (entry) => setChat((prev) => [...prev, entry]);

  // ---- Agent activity (ADR-0024): a user action that kicks off agent work expands the
  // conversation thread (blur behind, no collapse) until a new render is ready. ----
  const kickoff = () => { setAgentBusy(true); setRenderReady(false); setConsoleEscape(false); };
  const closeConsole = () => { setAgentBusy(false); setRenderReady(false); setConsoleEscape(false); setQuestion(null); setProcessing(false); setThreadOpen(false); };
  // Clean finish for work that lands NO new version — a chat reply, a finished review, an agent
  // "I'm done" status. Without this the working state would only ever clear on version.created, so
  // version-less work left agentBusy stuck true: the 20s heartbeat fired forever and the 75s
  // consoleEscape valve eventually flipped and vanished the surface. settle() drops the lock so
  // `working` goes false → heartbeat stops → the thread relaxes to a normal collapsible
  // conversation (messages retained). It does NOT touch renderReady (a version-ready surface owns
  // its own close) and does NOT force the panel shut — the transcript stays exactly where it is.
  const settle = () => { setAgentBusy(false); setQuestion(null); setProcessing(false); setConsoleEscape(false); };
  // Refs so the SSE handlers (stable closures) read the live state.
  const busyRef = useRef(false);
  const renderReadyRef = useRef(false);
  const reviewInFlightRef = useRef({});
  useEffect(() => { busyRef.current = agentBusy; }, [agentBusy]);
  useEffect(() => { renderReadyRef.current = renderReady; }, [renderReady]);
  useEffect(() => { reviewInFlightRef.current = reviewInFlight; }, [reviewInFlight]);
  const consoleActive = agentBusy || renderReady || !!question;   // the thread takes over as the live surface
  const working = (agentBusy || !!question) && !renderReady && !consoleEscape; // blur + lock-open while truly busy
  // Safety valve: if the agent goes quiet, let the user close after 75s (no permanent lock).
  useEffect(() => {
    if (!consoleActive || renderReady) return;
    const id = setTimeout(() => setConsoleEscape(true), 75000);
    return () => clearTimeout(id);
  }, [consoleActive, renderReady]);

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
    getConversation().then((log) => {
      const entries = Array.isArray(log) ? log : [];
      setChat(entries);
      // If this doc was just created with a brief, start in working mode so the Thread
      // opens immediately showing the brief and the "working" indicator — the agent will
      // either generate right away or ask a clarifying question through the same panel.
      try {
        const gen = sessionStorage.getItem("wi-generating");
        if (gen && gen === currentDoc) {
          sessionStorage.removeItem("wi-generating");
          // agentBusy + threadOpen already initialized from this flag before first paint
        }
      } catch { /* private mode / storage blocked */ }
    });
    listDocs().then(setDocs).catch(() => setDocs([]));
    getSources().then((r) => setSources(r.sources || [])).catch(() => setSources([]));
    getProjects().then((r) => { setProjects(r.projects || []); setProjectRoot(r.root || null); }).catch(() => {});
  }, [refreshVersions, checkPreflight]);

  async function attachSources(paths, note) {
    setShowPicker(false);
    if (showWizard) {
      // FsPicker was opened from the creation wizard — add paths to wizard, not the live session.
      setWizardSources((prev) => {
        const known = new Set(prev);
        return [...prev, ...paths.filter((p) => !known.has(p))];
      });
      return;
    }
    try {
      // Emit the attach intent; the source.attached frame echoes back and updates the panel.
      await emitSourceAttached(paths.map((p) => ({ path: p, note })));
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    }
  }

  // Remove an attached source from context: drop it optimistically + persist via the bus (the
  // service rewrites sources.json, so it stays gone on reload).
  async function removeSource(path) {
    setSources((prev) => prev.filter((s) => s.path !== path));
    try { await emitSourceRemoved(path); } catch (e) { setStatus({ kind: "error", text: e.message }); }
  }

  async function onCreateDoc(name, html, meta) {
    setWizardDocError(null);
    try {
      // Navigate to the SERVER-assigned slug, not the raw input — the service slugifies
      // (e.g. "My Doc" → "my-doc"), and ?doc= must be the slug or getCurrentDoc rejects it
      // and we'd land back on the launch screen.
      const created = await createDoc(name, html, meta);
      const docName = created?.name || name;
      // Server sets generating:true when it emits wicked.doc.created (brief-based creation).
      // Flag it so the new page opens in working mode — the agent generates v1 or asks a
      // clarifying question through the same Thread panel.
      if (created?.generating) {
        try { sessionStorage.setItem("wi-generating", docName); } catch { /* private mode */ }
      }
      navigateToDoc(docName);
    } catch (e) {
      setWizardDocError(e.message);
    }
  }

  async function onCreateDemo(name, _html, meta) {
    setWizardDemoError(null);
    try {
      const created = await createDoc(name, "", meta);   // kind:"demo" — service seeds the storyboard placeholder
      const docName = created?.name || name;
      try { sessionStorage.setItem("wi-generating", docName); } catch { /* private mode */ }
      navigateToDoc(docName);                            // new page opens in working state; agent records v1
    } catch (e) {
      setWizardDemoError(e.message);
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
      // A new render landed. If the agent console is open for this work, flip it to "ready"
      // (the user closes it to view); otherwise it's a background change — leave the console shut.
      if (["structural", "generated", "demo"].includes(payload.kind)) { setProcessing(false); setQuestion(null); }
      if (busyRef.current) { setRenderReady(true); setAgentBusy(false); }
    },
    "wicked.feedback.processed": (payload) => {
      setStatus(summarize(payload));
      appendChat({ role: "event", text: summarize(payload).text });
      if (payload.awaiting_structural > 0) {
        setProcMsg(`Working on it… (${payload.awaiting_structural} block${payload.awaiting_structural > 1 ? "s" : ""})`);
        setAgentBusy(true);
      } else {
        setProcessing(false);
      }
    },
    "wicked.status.posted": (payload) => {
      // Review narration must NEVER veil/lock the canvas (reviews are non-blocking + concurrent —
      // the user keeps editing). The agent tags review status with `review:true`; as a belt-and-
      // braces fallback we also treat a "working" status as review-only when a review is in flight
      // and no edit/question is active. A review status routes its message into the review thread.
      const isReview = payload.review === true || payload.kind === "review";
      if (payload.message || payload.question) { appendChat({ role: isReview ? "review" : "agent", text: payload.question || payload.message }); setRealStatusAt(Date.now()); }
      if (payload.state === "asking") {
        setQuestion({ text: payload.question, options: payload.options || [], requestId: payload.request_id });
        setProcMsg(payload.message || "A quick question");
        setProcessing(true); setAgentBusy(true);
      } else if (payload.state === "processing") {
        // Agent-driven redraw (e.g. from chat) — show the loading overlay on the document.
        setProcessing(true); setAgentBusy(true);
        if (payload.message) setProcMsg(payload.message);
      } else {
        // "working" is a non-lock progress state (demo recording, source indexing, REVIEWS) —
        // narrate it live, but a review-only spell must not trip the lock path.
        if (payload.message) setProcMsg(payload.message);
        if (payload.state === "working" && !isReview && !busyRef.current) setAgentBusy(true);
        // The agent posts a "complete" status when it finishes work that produced NO new version
        // (a chat reply, a finished review). Treat it as a clean finish: settle() drops the lock so
        // `working` goes false, the 20s heartbeat stops, and the thread relaxes to a normal
        // collapsible conversation with its messages intact. A review's "complete" is non-blocking
        // and never held the lock, so settle() is a harmless no-op there. Skip only when a new
        // version is already staged (renderReady) — that surface owns its own close.
        if (payload.state === "complete" && !renderReadyRef.current) settle();
        if (payload.state === "error") { setProcessing(false); setAgentBusy(false); setStatus({ kind: "error", text: payload.message || "error" }); }
      }
    },
    "wicked.chat.posted": (payload) => {
      appendChat({ role: payload.role || "user", text: payload.text });
      // A review verdict can also arrive as a chat line (role:"review", SKILL Step 8.6). If it
      // names its reviewer, clear that reviewer's in-flight indicator on the rail.
      if (payload.role === "review" && payload.reviewer) {
        setReviewInFlight((m) => ({ ...m, [payload.reviewer]: false }));
      }
    },
    // Reviews are non-blocking + concurrent: a verdict streams straight into the Thread and clears
    // ONLY that reviewer's rail spinner — it never touches the agentBusy/veil lock path.
    "wicked.review.completed": (payload) => {
      const text = payload.verdict || payload.message || (payload.reviewer ? `${payload.reviewer} review complete` : "Review complete");
      appendChat({ role: "review", text });
      setRealStatusAt(Date.now());
      if (payload.reviewer) setReviewInFlight((m) => ({ ...m, [payload.reviewer]: false }));
      else setReviewInFlight({});   // unspecified reviewer — clear all in-flight
    },
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
    // Service grabbed the URL → the agent is now reading the design. No lock: completion arrives
    // as wicked.status.posted + wicked.version.created (the re-theme lands a new version).
    "wicked.theme.learned": () => {
      setStatus({ kind: "ok", text: "Reading the design…" });
      setAgentBusy(true);
    },
    "wicked.error.raised": (payload) => {
      setProcessing(false);
      setAgentBusy(false);
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
    kickoff();
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
    kickoff();
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
    // Launch state — no document to talk about yet. Rather than dead-end on "unknown doc",
    // carry the first message into a new document as its brief; the agent builds from it.
    if (!currentDoc) {
      setWizardDocError(null);
      setNewDocBrief(text);
      setWizardPath("interactive");
      setShowWizard(true);
      return;
    }
    kickoff();   // expand the thread so the user sees the agent working + can nudge it
    try {
      // If the agent is waiting on a question, the composer answers it; otherwise it's a chat.
      if (question) { const q = question; setQuestion(null); await emitAnswer(q.requestId, text); }
      else await emitChat(text); // the bridge echoes it into the transcript
    } catch (e) { appendChat({ role: "event", text: `(couldn't send: ${e.message})` }); }
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

  // The "alive while working" signal in the Thread is now carried entirely by the rotating
  // whimsy filler (gated on `working`) plus the real wicked.status.posted messages — no separate
  // "working on it…" bubble, which used to double up with both of those.

  const [wizardSources, setWizardSources] = useState([]);  // source paths selected during doc creation

  const openNewDoc = () => { setWizardDocError(null); setWizardDemoError(null); setNewDocBrief(""); setWizardPath("interactive"); setWizardSources([]); setShowWizard(true); };
  const openNewDemo = () => { setWizardDocError(null); setWizardDemoError(null); setWizardPath("demo"); setShowWizard(true); };
  const closeWizard = () => { setShowWizard(false); setWizardPath(null); setNewDocBrief(""); setWizardSources([]); };

  function openWizardSourcePicker() { setPickMode("sources"); setShowPicker(true); }
  function addWizardSources(paths) {
    setShowPicker(false);
    setWizardSources((prev) => {
      const known = new Set(prev);
      return [...prev, ...paths.filter((p) => !known.has(p))];
    });
  }
  function removeWizardSource(path) { setWizardSources((prev) => prev.filter((p) => p !== path)); }
  const openThemeUrl = () => { setThemeUrlError(null); setShowThemeUrl(true); };

  async function learnThemeFromUrl(url) {
    setThemeUrlError(null);
    try {
      kickoff();
      await emitThemeFromUrl(url);   // service grabs → agent reads → re-themes (status + version.created)
      setShowThemeUrl(false);
      setStatus({ kind: "ok", text: "Learning that theme…" });
    } catch (e) {
      setThemeUrlError(e.message);
    }
  }

  // + menu → "From a PDF or image": pick a LOCAL file; the agent reads it in place (nothing
  // uploads) and re-themes. Routed through the same FsPicker, in "theme" mode.
  const openLearnFile = () => { setPickMode("theme"); setShowPicker(true); };
  const openAttach = () => { setPickMode("sources"); setShowPicker(true); };
  async function learnThemeFromFile(paths) {
    const file = (paths || [])[0];
    if (!file) return;
    try {
      kickoff();
      await emitThemeFromFile(file);
      setStatus({ kind: "ok", text: "Learning that style…" });
    } catch (e) {
      appendChat({ role: "event", text: `(couldn't learn that style: ${e.message})` });
    }
  }

  // Reviews are NON-BLOCKING + CONCURRENT (Change-2): a review NEVER calls kickoff() — it does not
  // enter the locked/veiled working state, so the user keeps editing the document while it runs.
  // We mark THAT reviewer in-flight (rail shows a spinner) and emit the request for it alone;
  // multiple reviewers can be in flight at once. The verdict streams back into the Thread via
  // wicked.review.completed / wicked.chat.posted(role:"review") and clears just that spinner.
  async function startReview(key) {
    if (!key || reviewInFlightRef.current[key]) return;   // already running this one
    setReviewInFlight((m) => ({ ...m, [key]: true }));
    setThreadOpen(true);   // surface the conversation so the verdict is visible — but no lock/veil
    try {
      await emitReviewRequested([key]);
      const label = REVIEW_LABEL[key] || key;
      appendChat({ role: "review", text: `Running the ${label} review…` });
    } catch (e) {
      setReviewInFlight((m) => ({ ...m, [key]: false }));
      appendChat({ role: "event", text: `(couldn't start ${key} review: ${e.message})` });
    }
  }

  // Partition the registry by kind (ADR-0018): demos render in their own nav section.
  const docKind = (d) => (typeof d === "string" ? "doc" : d.kind || "doc");
  const demos = docs.filter((d) => docKind(d) === "demo");
  const documents = docs.filter((d) => docKind(d) !== "demo");
  // manifest.kind is available from refreshVersions() before listDocs() resolves, so use it as
  // an early signal to avoid briefly showing the iframe (white storyboard HTML) while docs load.
  const currentIsDemo = currentDoc && (
    demos.some((d) => (typeof d === "string" ? d : d.name) === currentDoc) ||
    manifest?.kind === "demo"
  );
  useEffect(() => { isDemoRef.current = !!currentIsDemo; }, [currentIsDemo]);
  // The Interactive/Demo toggle only applies to an open interactive doc — reset it otherwise.
  useEffect(() => { if ((!currentDoc || currentIsDemo) && demoMode) setDemoMode(false); }, [currentDoc, currentIsDemo, demoMode]);

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

  async function handleAddScene({ description, mode }) {
    const modeLabel = mode === "rerecord" ? "re-record from the beginning" : "add it as a new scene";
    const msg = `Add a scene: ${description}\n\nMode: ${modeLabel}`;
    try { await emitChat(msg); } catch { /* bus down — message still shows */ }
    setThreadOpen(true);
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
    <div className={`wi-app${sideOpen ? " wi-app--side-open" : ""}`}>
      <aside
        className={`wi-sidebar${sideHover ? " is-hovering" : ""}`}
        onMouseEnter={() => { if (!sideSuppressRef.current) setSideHover(true); }}
        onMouseLeave={() => { sideSuppressRef.current = false; setSideHover(false); }}
      >
        <div className="wi-sidebar__inner">
          <div className="wi-sidebar__brand">
            <span className="wi-logo__mark" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#232324" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5l3.5 14L12 8l5.5 11L21 5" />
              </svg>
            </span>
            <span className="wi-sidebar__word"><b>wicked</b><i>agile</i><small>wicked-interactive</small></span>
            <button className="wi-sidebar__pin" title={sideOpen ? "Collapse sidebar" : "Keep sidebar open"} aria-label="Toggle sidebar" onClick={() => setSideOpen((o) => { const next = !o; if (!next) { sideSuppressRef.current = true; setSideHover(false); } return next; })}>{sideOpen ? "⇤" : "⇥"}</button>
          </div>
          <ProjectSwitcher projects={projects} currentRoot={projectRoot} expanded={sideOpen || sideHover} />
          <RailSection title="Documents" newLabel="New document" onNew={openNewDoc} items={documents} currentDoc={currentDoc} glyph="doc" newRef={newDocRef} />
          <div className="wi-rail__sep" />
          <RailSection title="Demos" newLabel="New demo" onNew={openNewDemo} items={demos} currentDoc={currentDoc} glyph="demo" newRef={newDemoRef} />
          <div className="wi-sidebar__spacer" />
        </div>
      </aside>

      <div className="wi-main">
        <header className="wi-toolbar wi-toolbar--top">
          <div className="wi-toolbar__group">
            <span className={`wi-crumb wi-brandcrumb${(sideOpen || sideHover) ? " is-doconly" : ""}`}>
              <span className="wi-brandcrumb__brand"><b>wicked</b><i>interactive</i></span>
              {currentDoc && <span className="wi-brandcrumb__doc"><span className="wi-brandcrumb__sep"> / </span><b>{currentDoc}</b></span>}
            </span>
          </div>
        <div className="wi-toolbar__group wi-toolbar__group--center">
          <VersionStrip manifest={manifest} viewing={viewing} onView={(v) => { setViewing(v); setSelected(null); }} />
          {manifest && !viewingIsHead && (
            <button className="wi-btn wi-btn--ghost" onClick={() => startAgainFrom(viewing)}>↳ Start again from v{viewing}</button>
          )}
        </div>
        <div className="wi-toolbar__group">
          {status && currentDoc && <div className={`wi-status wi-status--${status.kind}`}>{status.text}</div>}
          {currentIsDemo ? (
            <a
              className={`wi-btn wi-btn--primary wi-download${viewing == null ? " wi-download--disabled" : ""}`}
              href={viewing == null ? undefined : apiPath(`/api/demo/recording/_v${viewing}.mp4`)}
              download={`${currentDoc}-v${viewing}.mp4`}
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
          {currentIsDemo && (
            <button
              className="wi-btn wi-btn--ghost wi-btn--convert"
              onClick={() => { setWizardDocError(null); setNewDocBrief(currentDoc || ""); setWizardPath("interactive"); setShowWizard(true); }}
              title="Create an interactive document from this demo"
            >
              → Interactive
            </button>
          )}
          {currentDoc && !currentIsDemo && (
            <button
              className="wi-btn wi-btn--ghost wi-btn--convert"
              onClick={() => { setWizardDemoError(null); setWizardPath("demo"); setShowWizard(true); }}
              title="Create a demo video from this document"
            >
              → Demo
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
              <button className="wi-export__seg" disabled={viewing == null || processing} onClick={() => exportAs("pptx")} title="Export as native, editable PowerPoint">PPTX</button>
            </div>
          )}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

        <main className="wi-canvas" ref={canvasRef}>
        {!currentDoc && !showWizard && (
          <div className="wi-blank">
            <span className="wi-blank__icon" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v5h5M7 3h8l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /></svg>
            </span>
            <span className="wi-kicker">Live edit</span>
            <h2 className="wi-blank__title">Start something</h2>
            <p className="wi-blank__hint">Describe what you want in the box below and I'll build it — or open a document from the sidebar. Once a document's open, the right-edge tool-rail lets you learn a style or run a review.</p>
          </div>
        )}
        {currentDoc && !currentIsDemo && manifest && (
          <div className={`wi-doc ${processing ? "wi-doc--busy" : ""}`}>
            <div className="wi-doc__chrome" aria-hidden="true">
              <span className="wi-doc__lights"><i /><i /><i /></span>
              <span className="wi-doc__url">localhost · {currentDoc}.html{viewing != null ? ` · v${viewing}` : ""}</span>
              <span className="wi-doc__live"><i /> live</span>
            </div>
            <div className="wi-doc__stage">
              <iframe ref={iframeRef} title="document" src={viewing == null ? "about:blank" : docUrl(viewing)} onLoad={onIframeLoad} />
              <Overlay rects={rects} pending={EMPTY} hovered={hovered} selected={selected?.selector} onRemove={removeBlock} />
              <InlineComment selected={selected} rect={selected ? rects[selected.selector] : null} onSubmit={submitComment} onCancel={() => setSelected(null)} />
            </div>
          </div>
        )}
        {currentDoc && currentIsDemo && !showWizard && (
          <DemoStoryboard
            currentDoc={currentDoc}
            viewing={viewing}
            storyboardUrl={viewing == null ? null : docUrl(viewing)}
            videoSrc={viewing == null ? null : apiPath(`/api/demo/recording/_v${viewing}.webm`)}
            posterSrc={viewing == null ? null : apiPath(`/api/demo/recording/_v${viewing}-poster.jpg`)}
            processing={processing}
            onOpenThread={() => setThreadOpen(true)}
            onSetBusy={() => setAgentBusy(true)}
          />
        )}
        {showWizard && (
          <CreationWizard
            open={showWizard}
            initialPath={wizardPath}
            initialBrief={newDocBrief}
            sourcePaths={wizardSources}
            onBrowseSources={openWizardSourcePicker}
            onRemoveSource={removeWizardSource}
            onCreateDoc={onCreateDoc}
            onCreateDemo={onCreateDemo}
            onCancel={closeWizard}
            docError={wizardDocError}
            demoError={wizardDemoError}
          />
        )}
        {working && <div className="wi-veil" aria-hidden="true" />}
        {currentDoc && !currentIsDemo && !working && !showWizard && (
          <ToolRail
            onLearnWebsite={openThemeUrl}
            onLearnFile={openLearnFile}
            reviewInFlight={reviewInFlight}
            onStartReview={startReview}
          />
        )}
      </main>

        <Thread
          log={chat}
          open={threadOpen}
          forceOpen={consoleActive}
          lockOpen={working}
          working={working}
          realStatusAt={realStatusAt}
          onHeartbeat={() => { emitStatusRequested("ui-heartbeat").catch(() => {}); }}
          question={question}
          onAnswer={answerQuestion}
          renderReady={renderReady}
          onClose={closeConsole}
          onToggle={() => setThreadOpen((o) => !o)}
          hasDoc={!!currentDoc}
        />

        <Composer
          onSend={sendChat}
          busy={processing}
          logLen={chat.length}
          demoMode={demoMode}
          sources={sources}
          onRemoveSource={removeSource}
          onAttach={openAttach}
          onRecordDemo={openNewDemo}
        />
      </div>

      <FsPicker open={showPicker} onAdd={pickMode === "theme" ? learnThemeFromFile : attachSources} onCancel={() => setShowPicker(false)} />

      <ThemeFromUrlModal
        open={showThemeUrl}
        error={themeUrlError}
        onSubmit={learnThemeFromUrl}
        onCancel={() => setShowThemeUrl(false)}
      />

      <InstallGate preflight={preflight} onRetry={checkPreflight} />
    </div>
  );
}

const EMPTY = new Set();

/** Light/dark toggle in the toolbar. Sun glyph in dark mode (tap → light), moon in light mode. */
function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === "dark";
  return (
    <button
      className="wi-theme-toggle"
      onClick={onToggle}
      title={isDark ? "Switch to light" : "Switch to dark"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}

const RAIL_GLYPHS = {
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, // document
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
