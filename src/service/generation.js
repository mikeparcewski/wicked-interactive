// generation.js — delegate "build a document from my content" to the supervising agent
// (ADR-0010). The service is model-free: it cannot index files or generate HTML. So when a
// doc is created with kind:"source", the service seeds a placeholder v0 and writes
// requests/_gen.request.json; the agent reads the source materials, drives wicked-prezzie /
// wicked-brain, and writes requests/_gen.response.json with the full first draft. The
// service instruments + themes it and lands it as a follow-on version.
//
// Unlike a structural edit, the generated draft is a whole new document — there are no
// pre-existing data-wid anchors to preserve (the placeholder v0's anchors are throwaway),
// so instrument() simply assigns fresh ones.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { instrument } from "../core/instrument.js";
import { themed } from "./theme-source.js";
import { recordVersion, nextVersionNumber, getVersion } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest } from "./fsstore.js";

export const REQUESTS_DIR = "requests";
export const GEN_REQUEST = "_gen.request.json";
export const GEN_RESPONSE = "_gen.response.json";

/** Placeholder shown at v0 while the agent builds the real draft from the user's content. */
export function generationPlaceholder(name, sourcePaths) {
  const safe = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paths = (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]).filter(Boolean);
  const title = safe((name || "your document").replace(/-/g, " "));
  const sources = paths.length === 1
    ? `<code>${safe(paths[0])}</code>`
    : `${paths.length} locations`;
  const list = paths.length > 1
    ? `<ul>${paths.map((p) => `<li><code>${safe(p)}</code></li>`).join("")}</ul>`
    : "";
  return (
    `<section>` +
      `<h1>Building ${title}…</h1>` +
      `<p class="lead">Reading ${sources} and drafting your document. ` +
      `This view updates automatically the moment the first draft is ready.</p>` +
      list +
    `</section>`
  );
}

/**
 * Write the generation work request for a freshly-created source doc. The agent watches for
 * this file (or the `generation` SSE event) and fulfills it.
 * @returns {{ requestFile: string }}
 */
export function writeGenerationRequest(dir, { sourcePaths, brief = "", documentId = dir, baseHtmlFile = "_v0.html" }) {
  mkdirSync(join(dir, REQUESTS_DIR), { recursive: true });
  const paths = (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]).map((s) => String(s).trim()).filter(Boolean);
  const body = {
    document_id: documentId,
    source_paths: paths,
    brief,
    base_html: baseHtmlFile,
    ts: new Date().toISOString(),
  };
  atomicWrite(join(dir, REQUESTS_DIR, GEN_REQUEST), JSON.stringify(body, null, 2));
  return { requestFile: GEN_REQUEST };
}

/**
 * Apply the agent's generated draft as a follow-on version. Response shape: { html }.
 * Instruments (fresh data-wids) and themes the draft, then records it write-once (INV-4)
 * with the current head as parent.
 * @returns {Promise<{version:number, parent:number}>}
 */
export async function applyGeneratedDraft(dir, responseFile, opts = {}) {
  const resp = JSON.parse(readFileSync(join(dir, REQUESTS_DIR, responseFile), "utf-8"));
  const html = String(resp.html ?? "");
  if (!html.trim()) throw new Error("generation response missing html");

  let manifest = loadManifest(dir);
  const parent = manifest.head;
  const version = nextVersionNumber(manifest);
  const prepared = themed(instrument(html).html, opts);
  atomicWrite(join(dir, `_v${version}.html`), prepared);
  ({ manifest } = recordVersion(manifest, { version, parent, feedbackFile: responseFile }));
  saveManifest(dir, manifest);

  if (typeof opts.emit === "function") {
    opts.emit("HTML_UPDATED", {
      document_id: opts.documentId ?? dir,
      version, html_file: `_v${version}.html`, prev_version: parent, ts: new Date().toISOString(),
    });
  }
  return { version, parent };
}

/** Whether a doc still has a pending (unfulfilled) generation request. */
export function hasPendingGeneration(dir) {
  try {
    return getVersion(loadManifest(dir), 1) == null
      && readFileSync(join(dir, REQUESTS_DIR, GEN_REQUEST), "utf-8").length > 0;
  } catch { return false; }
}
