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

export async function createDoc(name, html) {
  const r = await fetch("/api/docs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, html }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "couldn't create doc");
  return data;
}
