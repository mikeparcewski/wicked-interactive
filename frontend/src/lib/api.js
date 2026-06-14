// api.js — thin HTTP client (ADR-0019). Two shapes now:
//  • STATE-PLANE reads + synchronous artifact commands → doc-prefixed HTTP (apiPath).
//  • CONTROL-PLANE intent (feedback / chat / answer / sources / demo) → ONE bus emit via
//    POST /api/events (top-level). The service validates the UI whitelist + enriches the
//    envelope; the result fans back over the SSE bridge (useSse).

import { apiPath, docSrc, getCurrentDoc } from "./apiPath.js";

export const docUrl = (version) => docSrc(version);

async function jpost(path, body) {
  const r = await fetch(apiPath(path), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed: ${path}`);
  return data;
}

// --- Control plane: emit a bus event (top-level POST /api/events, NEVER doc-prefixed).
// document_id is stamped from the current ?doc= so every payload routes to its workspace.
export async function postEvent(event_type, payload = {}) {
  const document_id = payload.document_id || getCurrentDoc();
  const r = await fetch("/api/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type, payload: { ...payload, document_id } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `emit failed: ${event_type}`);
  return data;
}

// Intent helpers (what the browser is allowed to originate — the UI whitelist).
export const emitFeedback = (items, author) => postEvent("wicked.feedback.submitted", { items, ...(author ? { author } : {}) });
export const emitChat = (text, role = "user") => postEvent("wicked.chat.posted", { role, text });
export const emitAnswer = (requestId, answer) => postEvent("wicked.question.answered", { request_id: requestId, answer });
export const emitSourceAttached = (added) => postEvent("wicked.source.attached", { added });
export const emitSourceRemoved = (path) => postEvent("wicked.source.removed", { path });
export const emitDemoRecord = () => postEvent("wicked.demo.requested", {});
// Learn a theme from a live URL: the service grabs it to a PDF, the agent reads the design and
// re-themes the current doc. document_id is stamped by postEvent.
export const emitThemeFromUrl = (url) => postEvent("wicked.theme.requested", { url });
// Learn a theme from a LOCAL file (PDF/image) the agent reads in place — nothing uploads.
export const emitThemeFromFile = (path) => postEvent("wicked.theme.requested", { path });
// Run a review pass on the current version with the selected reviewers; the agent posts
// verdicts back as wicked.chat.posted (role: "review").
export const emitReviewRequested = (reviewers) => postEvent("wicked.review.requested", { reviewers });
// Heartbeat while the agent is working: nudge it to post a real status update (the UI fires
// this on a timer during the working state). The agent answers with wicked.status.posted.
export const emitStatusRequested = (reason) => postEvent("wicked.status.requested", { ts: Date.now(), ...(reason ? { reason } : {}) });

// --- State-plane reads (doc-prefixed) ---
export async function getVersions() {
  const r = await fetch(apiPath("/api/versions"));
  if (!r.ok) throw new Error("failed to load versions");
  return r.json();
}

export async function getConversation() {
  const r = await fetch(apiPath("/api/conversation"));
  if (!r.ok) return [];
  return r.json();
}

export async function getSources() {
  const r = await fetch(apiPath("/api/sources"));
  if (!r.ok) return { sources: [] };
  return r.json();
}

// The running instances the project switcher offers (top-level route, not doc-scoped).
export async function getProjects() {
  try { const r = await fetch("/api/projects"); return r.ok ? r.json() : { root: null, projects: [] }; }
  catch { return { root: null, projects: [] }; }
}

// Local path picker — lists a directory's entries so the user navigates instead of typing.
export async function browseFs(path) {
  const r = await fetch(apiPath(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "couldn't read directory");
  return data;
}

// --- Synchronous artifact commands (doc-prefixed; each also emits its fact server-side) ---
export const postFork = (from) => jpost("/api/fork", { from });
export const postExport = (version, format) => jpost("/api/export", { version, format });
// Convert a recorded version's video to an embeddable animated GIF (cached server-side).
export const postDemoGif = (version) => jpost("/api/demo/gif", { version });

// --- Multi-doc registry + install gate (top-level, NEVER prefixed) ---
export async function listDocs() {
  const r = await fetch("/api/docs");
  if (!r.ok) return [];
  return r.json();
}

export async function getPreflight() {
  const r = await fetch("/api/preflight");
  if (!r.ok) return { ok: false, missing: [], required: {}, install_hint: null, unreachable: true };
  return r.json();
}

// meta: { kind: "blank"|"html"|"source"|"demo", sourcePaths?, brief?, url?, style? }.
export async function createDoc(name, html, meta = {}) {
  const body = { name, html };
  if (meta.kind === "source") {
    body.kind = "source";
    body.source_paths = Array.isArray(meta.sourcePaths) ? meta.sourcePaths : [];
    body.brief = meta.brief || "";
    if (meta.style) body.style = meta.style;
  } else if (meta.kind === "demo") {
    body.kind = "demo";
    body.url = meta.url || "";
    body.brief = meta.brief || "";
  } else if (meta.style) {
    body.style = meta.style;
  }
  const r = await fetch("/api/docs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "couldn't create doc");
  return data;
}
