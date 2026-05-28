import { useCallback, useEffect, useRef, useState } from "react";
import Overlay from "./components/Overlay.jsx";
import InlineComment from "./components/InlineComment.jsx";
import VersionStrip from "./components/VersionStrip.jsx";
import ProcessingLock from "./components/ProcessingLock.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import { useSse } from "./hooks/useSse.js";
import { docUrl, getVersions, postFeedback, postFork, postExport, postAnswer, postMessage, getConversation } from "./lib/api.js";
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

  useEffect(() => {
    refreshVersions().then((m) => setViewing((v) => (v == null ? m.head : v)));
    getConversation().then((log) => setChat(Array.isArray(log) ? log : []));
  }, [refreshVersions]);

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
  }, [recompute]);

  // ---- SSE: hot-reload + lock + chat transcript ----
  useSse("/events", {
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
      const { path } = await postExport(viewing, format);
      setStatus({ kind: "ok", text: `Exported ${format.toUpperCase()}: ${path}` });
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    }
  }

  const viewingIsHead = manifest && viewing === manifest.head;

  return (
    <div className="wi-app">
      <header className="wi-header">
        <span className="wi-logo">wicked-interactive</span>
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
        <ChatPanel log={chat} onSend={sendChat} busy={processing} collapsed={!chatOpen} onToggle={() => setChatOpen((o) => !o)} />
        <div className="wi-doc">
          <iframe ref={iframeRef} title="document" src={viewing == null ? "about:blank" : docUrl(viewing)} onLoad={onIframeLoad} />
          <Overlay rects={rects} pending={EMPTY} hovered={hovered} selected={selected?.selector} onRemove={removeBlock} />
          <InlineComment selected={selected} rect={selected ? rects[selected.selector] : null} onSubmit={submitComment} onCancel={() => setSelected(null)} />
          <ProcessingLock active={processing} message={procMsg} question={question?.text} options={question?.options}
            onAnswer={answerQuestion} onDismiss={() => { setProcessing(false); setQuestion(null); }} />
        </div>
      </div>
    </div>
  );
}

const EMPTY = new Set();

function summarize(data) {
  const parts = [];
  if (data.applied?.length) parts.push(`${data.applied.length} applied`);
  if (data.stale?.length) parts.push(`${data.stale.length} stale`);
  if (data.rejected?.length) parts.push(`${data.rejected.length} rejected`);
  const kind = data.rejected?.length ? "warn" : "ok";
  return { kind, text: `v${data.version}: ${parts.join(", ") || "no changes"}` };
}
