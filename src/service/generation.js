// generation.js — land "build a document from my content" drafts (ADR-0019). The service is
// model-free: it cannot index files or generate HTML. So when a doc is created with
// kind:"source", the service seeds a placeholder v0 and emits wicked.interactive.doc.created; the agent
// reads the source materials, drives wicked-brain + the craft references, and emits
// wicked.interactive.draft.completed with the full first draft. The service instruments + themes it and
// lands it as a follow-on version.
//
// Unlike a structural edit, the generated draft is a whole new document — there are no
// pre-existing data-wid anchors to preserve (the placeholder v0's anchors are throwaway),
// so instrument() simply assigns fresh ones.

import { join } from "node:path";
import { instrument } from "../core/instrument.js";
import { themed } from "./theme-source.js";
import { recordVersion, nextVersionNumber } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest } from "./fsstore.js";

/** Placeholder shown at v0 while the agent builds the real draft from the user's content. */
export function generationPlaceholder(name, sourcePaths, brief = "") {
  const safe = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paths = (Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths]).filter(Boolean);
  const title = safe((name || "your document").replace(/-/g, " "));
  // Brief-only generation is first-class: with no source files the agent drafts from the
  // brief alone, so the placeholder describes that instead of "0 locations".
  const sources = paths.length === 0
    ? "your brief"
    : paths.length === 1
      ? `<code>${safe(paths[0])}</code>`
      : `${paths.length} locations`;
  const list = paths.length > 1
    ? `<ul>${paths.map((p) => `<li><code>${safe(p)}</code></li>`).join("")}</ul>`
    : "";
  const briefBlock = paths.length === 0 && brief
    ? `<blockquote>${safe(brief)}</blockquote>`
    : "";
  return (
    `<section>` +
      `<h1>Building ${title}…</h1>` +
      `<p class="lead">Reading ${sources} and drafting your document. ` +
      `This view updates automatically the moment the first draft is ready.</p>` +
      briefBlock +
      list +
    `</section>`
  );
}

/**
 * Land the agent's generated draft (from a `wicked.interactive.draft.completed` event) as a follow-on
 * version. Instruments (fresh data-wids) and themes the draft, then records it write-once
 * (INV-4) with the current head as parent.
 * @returns {Promise<{version:number, parent:number}>}
 */
export async function applyGeneratedHtml(dir, html, opts = {}) {
  html = String(html ?? "");
  if (!html.trim()) throw new Error("generated draft missing html");

  let manifest = loadManifest(dir);
  const parent = manifest.head;
  const version = nextVersionNumber(manifest);
  const prepared = themed(instrument(html).html, opts);
  atomicWrite(join(dir, `_v${version}.html`), prepared);
  ({ manifest } = recordVersion(manifest, { version, parent, feedbackFile: opts.feedbackFile ?? null }));
  saveManifest(dir, manifest);
  return { version, parent };
}
