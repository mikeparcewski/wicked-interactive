// api.js — thin HTTP client. All paths route through apiPath() so the same bundle works in
// single-doc (legacy --dir) and multi-doc (--root + ?doc=) modes — see lib/apiPath.js.

import { apiPath, docSrc } from "./apiPath.js";

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

export async function getVersions() {
  const r = await fetch(apiPath("/api/versions"));
  if (!r.ok) throw new Error("failed to load versions");
  return r.json();
}

export const postFeedback = (items) => jpost("/api/feedback", { items });
export const postFork = (from) => jpost("/api/fork", { from });
export const postAnswer = (requestId, answer) => jpost("/api/answer", { requestId, answer });
export const postMessage = (text) => jpost("/api/message", { text });
export const postExport = (version, format) => jpost("/api/export", { version, format });

// Sources (ADR-0017) — reference paths the agent indexes into the brain. No uploads.
export async function getSources() {
  const r = await fetch(apiPath("/api/sources"));
  if (!r.ok) return { sources: [] };
  return r.json();
}
export const addSources = (paths, note) => jpost("/api/sources", { paths, note });

// Local path picker — lists a directory's entries so the user navigates instead of typing.
export async function browseFs(path) {
  const r = await fetch(apiPath(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "couldn't read directory");
  return data;
}

export async function getConversation() {
  const r = await fetch(apiPath("/api/conversation"));
  if (!r.ok) return [];
  return r.json();
}

// Multi-doc registry (ADR-0015) — these are top-level, NEVER prefixed.
export async function listDocs() {
  const r = await fetch("/api/docs");
  if (!r.ok) return [];
  return r.json();
}

// Plugin install-gate (ADR-0016) — top-level, NEVER prefixed.
export async function getPreflight() {
  const r = await fetch("/api/preflight");
  if (!r.ok) return { ok: false, missing: [], required: {}, install_hint: null, unreachable: true };
  return r.json();
}

// meta: { kind: "blank"|"html"|"source"|"demo", sourcePaths?, brief?, url? }.
//   kind:"source" — service seeds a placeholder; the agent builds the first draft from files/brief.
//   kind:"demo"   — point at a live URL (ADR-0018); the agent learns the app, authors the
//                   click-path, and the service records it as a storyboard version.
export async function createDoc(name, html, meta = {}) {
  const body = { name, html };
  if (meta.kind === "source") {
    body.kind = "source";
    body.source_paths = Array.isArray(meta.sourcePaths) ? meta.sourcePaths : [];
    body.brief = meta.brief || "";
  } else if (meta.kind === "demo") {
    body.kind = "demo";
    body.url = meta.url || "";
    body.brief = meta.brief || "";
  }
  const r = await fetch("/api/docs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "couldn't create doc");
  return data;
}

// Trigger a (re-)record of a demo's authored spec (ADR-0018). The service executes
// demo.spec.mjs with Playwright and lands the storyboard as a new version. Doc-scoped.
export const postDemoRecord = () => jpost("/api/demo/record", {});

// Convert a recorded version's video to an embeddable animated GIF (cached server-side).
// Returns { download, file, bytes } — the caller fetches `download` to save it.
export const postDemoGif = (version) => jpost("/api/demo/gif", { version });
