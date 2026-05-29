import { useCallback, useEffect, useRef, useState } from "react";
import Overlay from "./components/Overlay.jsx";
import InlineComment from "./components/InlineComment.jsx";
import VersionStrip from "./components/VersionStrip.jsx";
import ProcessingLock from "./components/ProcessingLock.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import DocPicker from "./components/DocPicker.jsx";
import NewDocModal from "./components/NewDocModal.jsx";
import InstallGate from "./components/InstallGate.jsx";
import { useSse } from "./hooks/useSse.js";
import { docUrl, getVersions, postFeedback, postFork, postExport, postAnswer, postMessage, getConversation, listDocs, createDoc, getPreflight } from "./lib/api.js";
import { getCurrentDoc, navigateToDoc, eventsUrl } from "./lib/apiPath.js";
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
  const [newDocError, setNewDocError] = useState(null);
  const [preflight, setPreflight] = useState(null);      // install-gate state (ADR-0016)
  const currentDoc = getCurrentDoc();

  const iframeRef = useRef(null);
  const pendingScroll = useRef(null);
  const submittedVersion = useRef(null);
  const viewingRef = useRef(null);
  const headRef = useRef(null);
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
  }, [refreshVersions, checkPreflight]);

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

  // ---- SSE: hot-reload + lock + chat transcript ----
  useSse(eventsUrl(), {
    "html-updated": async () => {
      const wasFollowing = viewingRef.current == null || viewingRef.current === headRef.current;
      const m = await refreshVersions();
      if (wasFollowing) {
        pendingScroll.current = iframeRef.current?.contentWindow?.scrollY ?? 0;
        setViewing(m.head);
      }
    },
    processed: (data) => {
      setStatus(summarize(data));
      appendChat({ role: "event", text: summarize(data).text });
      if (data.structural) { setProcessing(false); submittedVersion.current = null; return; }
      if (submittedVersion.current != null && data.version === submittedVersion.current) {
        if (data.awaiting_structural > 0) {
          setProcMsg(`Working on it… (${data.awaiting_structural} block${data.awaiting_structural > 1 ? "s" : ""})`);
        } else {
          setProcessing(false);
          submittedVersion.current = null;
        }
      }
    },
    status: (data) => {
      if (data.message || data.question) appendChat({ role: "agent", text: data.question || data.message });
      if (data.state === "asking") {
        setQuestion({ text: data.question, options: data.options || [], requestId: data.requestId });
        setProcMsg(data.message || "A quick question");
        setProcessing(true);
      } else if (data.state === "processing" || data.state === "awaiting-agent") {
        // Agent-driven redraw (e.g. from chat) — show the loading overlay on the document.
        setProcessing(true);
        if (data.message) setProcMsg(data.message);
      } else {
        if (data.message) setProcMsg(data.message);
        if (data.state === "complete") { setProcessing(false); setQuestion(null); submittedVersion.current = null; }
        if (data.state === "error") { setProcessing(false); setStatus({ kind: "error", text: data.message || "error" }); }
      }
    },
    message: (data) => appendChat({ role: data.role || "user", text: data.text }),
    error: (data) => {
      setProcessing(false);
      setStatus({ kind: "error", text: data.error || "regeneration failed" });
    },
  });

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
      const { version } = await postFeedback([item]);
      submittedVersion.current = version;
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
      const { version } = await postFeedback([buildItem({ selector, type: "remove" })]);
      submittedVersion.current = version;   // deterministic — unlocks on `processed`
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
      setProcessing(false);
    }
  }

  async function sendChat(text) {
    try { await postMessage(text); } // the broadcast echoes it into the transcript
    catch (e) { appendChat({ role: "event", text: `(couldn't send: ${e.message})` }); }
  }

  async function answerQuestion(answer) {
    const q = question;
    setQuestion(null);
    setProcMsg("Thanks — continuing…");
    try { await postAnswer(q.requestId, answer); }
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

  return (
    <div className="wi-app">
      <header className="wi-header">
        <span className="wi-logo">wicked-interactive</span>
        <DocPicker docs={docs} current={currentDoc} onSelect={navigateToDoc} onNew={() => { setNewDocError(null); setShowNewDoc(true); }} />
        <span className="wi-spacer" />
        <VersionStrip manifest={manifest} viewing={viewing} onView={(v) => { setViewing(v); setSelected(null); }} />
        {manifest && !viewingIsHead && (
          <button className="wi-btn wi-btn--ghost" onClick={() => startAgainFrom(viewing)}>↳ Start again from v{viewing}</button>
        )}
        <span className="wi-spacer" />
        <button className="wi-btn" disabled={viewing == null || processing} onClick={() => exportAs("html")}>Export HTML</button>
        <button className="wi-btn" disabled={viewing == null || processing} onClick={() => exportAs("pdf")}>Export PDF</button>
      </header>

      {status && <div className={`wi-status wi-status--${status.kind}`}>{status.text}</div>}

      <div className="wi-stage">
        <ChatPanel log={chat} onSend={sendChat} busy={processing} agentThinking={agentThinking} collapsed={!chatOpen} onToggle={() => setChatOpen((o) => !o)} />
        <div className="wi-doc">
          <iframe ref={iframeRef} title="document" src={viewing == null ? "about:blank" : docUrl(viewing)} onLoad={onIframeLoad} />
          <Overlay rects={rects} pending={EMPTY} hovered={hovered} selected={selected?.selector} onRemove={removeBlock} />
          <InlineComment selected={selected} rect={selected ? rects[selected.selector] : null} onSubmit={submitComment} onCancel={() => setSelected(null)} />
          <ProcessingLock active={processing} message={procMsg} question={question?.text} options={question?.options}
            onAnswer={answerQuestion} onDismiss={() => { setProcessing(false); setQuestion(null); }} />
        </div>
      </div>

      <NewDocModal
        open={showNewDoc}
        error={newDocError}
        onCreate={onCreateDoc}
        onCancel={() => setShowNewDoc(false)}
      />

      <InstallGate preflight={preflight} onRetry={checkPreflight} />
    </div>
  );
}

const EMPTY = new Set();

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
