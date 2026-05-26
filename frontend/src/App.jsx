import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Overlay from "./components/Overlay.jsx";
import FeedbackPanel from "./components/FeedbackPanel.jsx";
import VersionStrip from "./components/VersionStrip.jsx";
import { useSse } from "./hooks/useSse.js";
import { docUrl, getVersions, postFeedback } from "./lib/api.js";
import { emptyFeedback, upsertItem, removeItem, clearItems } from "./lib/feedbackStore.js";
import { nearestReviewable, describe } from "./lib/selection.js";

function feedbackReducer(state, action) {
  switch (action.type) {
    case "upsert": return upsertItem(state, action.item);
    case "remove": return removeItem(state, action.selector);
    case "clear": return clearItems();
    default: return state;
  }
}

export default function App() {
  const [manifest, setManifest] = useState(null);
  const [viewing, setViewing] = useState(null);          // version currently shown
  const [feedback, dispatch] = useReducer(feedbackReducer, emptyFeedback);
  const [selected, setSelected] = useState(null);        // describe() of clicked block
  const [hovered, setHovered] = useState(null);          // hovered selector
  const [rects, setRects] = useState({});                // selector -> bounding rect
  const [status, setStatus] = useState(null);            // last processed/rejected notice
  const [busy, setBusy] = useState(false);

  const iframeRef = useRef(null);
  const pendingScroll = useRef(null);
  const pendingSelectors = new Set(feedback.items.map((i) => i.selector));

  const refreshVersions = useCallback(async () => {
    const m = await getVersions();
    setManifest(m);
    return m;
  }, []);

  useEffect(() => {
    refreshVersions().then((m) => setViewing((v) => (v == null ? m.head : v)));
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

  useEffect(() => { recompute(); }, [feedback, recompute]);

  // ---- SSE: hot-reload on new version ----
  useSse("/events", {
    "html-updated": async (data) => {
      const m = await refreshVersions();
      // If we were viewing the previous head, follow to the new head (preserve scroll).
      setViewing((cur) => {
        if (cur == null || cur === data.prev_version) {
          pendingScroll.current = iframeRef.current?.contentWindow?.scrollY ?? 0;
          return m.head;
        }
        return cur;
      });
    },
    processed: (data) => setStatus(summarize(data)),
    error: (data) => setStatus({ kind: "error", text: data.error || "regeneration failed" }),
  });

  // ---- actions ----
  function addFeedback(item) { dispatch({ type: "upsert", item }); setSelected(null); }
  function dropFeedback(sel) { dispatch({ type: "remove", selector: sel }); }

  async function update() {
    if (feedback.items.length === 0 || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await postFeedback(feedback.items);
      dispatch({ type: "clear" });   // the new version arrives via SSE
    } catch (e) {
      setStatus({ kind: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const existingFor = (sel) => feedback.items.find((i) => i.selector === sel);

  return (
    <div className="wi-app">
      <header className="wi-header">
        <span className="wi-logo">wicked-interactive</span>
        <VersionStrip manifest={manifest} viewing={viewing} onView={(v) => { setViewing(v); setSelected(null); }} />
        <button className="wi-btn wi-btn--primary" disabled={feedback.items.length === 0 || busy} onClick={update}>
          {busy ? "Updating…" : `UPDATE${feedback.items.length ? ` (${feedback.items.length})` : ""}`}
        </button>
      </header>

      {status && <div className={`wi-status wi-status--${status.kind}`}>{status.text}</div>}

      <div className="wi-stage">
        <div className="wi-doc">
          <iframe
            ref={iframeRef}
            title="document"
            src={viewing == null ? "about:blank" : docUrl(viewing)}
            onLoad={onIframeLoad}
          />
          <Overlay rects={rects} pending={pendingSelectors} hovered={hovered} selected={selected?.selector} />
        </div>

        <aside className="wi-side">
          {selected
            ? <FeedbackPanel selected={selected} existing={existingFor(selected.selector)} onSubmit={addFeedback} onCancel={() => setSelected(null)} />
            : <p className="wi-hint">Click any block in the document to give feedback.</p>}

          <div className="wi-pending">
            <h3>Pending feedback ({feedback.items.length})</h3>
            {feedback.items.map((i) => (
              <div key={i.selector} className="wi-pending__item">
                <code>{i.selector}</code> <em>{i.type}</em>
                <button className="wi-x" onClick={() => dropFeedback(i.selector)} aria-label="remove">×</button>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function summarize(data) {
  const parts = [];
  if (data.applied?.length) parts.push(`${data.applied.length} applied`);
  if (data.stale?.length) parts.push(`${data.stale.length} stale (skipped)`);
  if (data.rejected?.length) parts.push(`${data.rejected.length} rejected`);
  const kind = data.rejected?.length ? "warn" : "ok";
  return { kind, text: `v${data.version}: ${parts.join(", ") || "no changes"}` };
}
