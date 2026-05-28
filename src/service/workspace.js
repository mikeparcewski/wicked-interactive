// workspace.js — a document workspace on disk and the feedback->regenerate pipeline.
//
// Layout (one directory per document):
//   _v0.html, _v1.html, ...   version artifacts (write-once, INV-4)
//   _v1.md, _v2.md, ...       feedback files (no _v0.md — v0 is the initial build)
//   versions.json             parent-pointer manifest (ADR-0008)
//   requests/                 structural-change delegation to the agent (ADR-0010)
//
// The service is the SINGLE writer of feedback files (ADR-0002): writes are atomic so the
// watcher never reads a half-written file. Deterministic edits apply immediately;
// structural edits are delegated to the supervising agent (ADR-0010).

import { readFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { instrument } from "../core/instrument.js";
import { parseFeedback, serializeFeedback } from "../core/feedback-schema.js";
import { regenerate } from "../core/regenerate.js";
import { initManifest, recordVersion, getVersion, nextVersionNumber } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest, readVersionHtml } from "./fsstore.js";
import { splitItems, writeStructuralRequest } from "./structural.js";

// Re-export the store reads so existing callers (server, tests) keep their import path.
export { loadManifest, readVersionHtml } from "./fsstore.js";

const versionFromHtmlFile = (f) => Number(/_v(\d+)\.html$/.exec(f)?.[1]);

// Highest _v{n}.{md,html} on disk — so rapid writes reserve distinct numbers even before
// the manifest is updated (two quick UPDATEs must not both grab _v1.md).
function highestVersionOnDisk(dir) {
  let max = -1;
  for (const f of readdirSync(dir)) {
    const m = /^_v(\d+)\.(md|html)$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Initialise a workspace from an HTML draft. Instruments it with data-wid (unless
 * opts.instrument === false), writes _v0.html, and seeds the manifest.
 */
export function initWorkspace(dir, html, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const prepared = opts.instrument === false ? html : instrument(html).html;
  atomicWrite(join(dir, "_v0.html"), prepared);
  const manifest = initManifest("_v0.html");
  saveManifest(dir, manifest);
  return { manifest };
}

/**
 * Write a feedback file as the single writer. Allocates the next version number,
 * validates the feedback (round-trips through the schema), and writes _v{n}.md atomically.
 * Does NOT touch the manifest — the version becomes real only once its HTML is produced.
 */
export function writeFeedback(dir, { items, author }) {
  const manifest = loadManifest(dir);
  const base = getVersion(manifest, manifest.head);
  const version = Math.max(nextVersionNumber(manifest), highestVersionOnDisk(dir) + 1);
  const feedback = {
    frontmatter: {
      version, base_html: base.html_file, timestamp: new Date().toISOString(),
      ...(author ? { author } : {}),
    },
    items,
  };
  const md = serializeFeedback(feedback);
  parseFeedback(md); // validate by round-trip; throws on invalid schema
  const file = `_v${version}.md`;
  atomicWrite(join(dir, file), md);
  return { version, file };
}

/**
 * Fork from an existing version (AC-21): non-destructive "start again from here". Copies
 * _v{from}.html to a new write-once version whose parent is `from`; the new version becomes
 * the head. Nothing is removed (AC-22).
 * @returns {{ version: number, parent: number }}
 */
export function forkVersion(dir, from) {
  let manifest = loadManifest(dir);
  if (getVersion(manifest, from) == null) throw new Error(`fork: v${from} does not exist`);
  const version = Math.max(nextVersionNumber(manifest), highestVersionOnDisk(dir) + 1);
  copyFileSync(join(dir, `_v${from}.html`), join(dir, `_v${version}.html`));
  ({ manifest } = recordVersion(manifest, { version, parent: from, feedbackFile: null }));
  saveManifest(dir, manifest);
  return { version, parent: from };
}

/**
 * Process a feedback file: apply the DETERMINISTIC edits immediately (cheerio), write the
 * partial _v{n}.html, record the version, and emit. STRUCTURAL items are delegated to the
 * supervising agent via a request file (ADR-0010) and finalized later as a follow-on
 * version. Idempotent on (version).
 * @returns {Promise<{version,html_file,applied,rejected,stale,awaiting_structural}>}
 */
export async function processFeedbackFile(dir, mdFile, opts = {}) {
  const md = readFileSync(join(dir, mdFile), "utf-8");
  const feedback = parseFeedback(md);
  const version = feedback.frontmatter.version;
  const parent = versionFromHtmlFile(feedback.frontmatter.base_html);

  let manifest = loadManifest(dir);
  if (getVersion(manifest, version) != null) {
    const existing = getVersion(manifest, version);
    return { version, html_file: existing.html_file, applied: [], rejected: [], stale: [], awaiting_structural: 0, idempotent: true };
  }

  const { deterministic, structural } = splitItems(feedback.items);
  const prevHtml = readVersionHtml(dir, parent);
  const { html: regenerated, applied, rejected, stale } = await regenerate(prevHtml, { items: deterministic }, {});
  // Re-instrument so any new h2/p/li introduced by the regen pick up a data-wid.
  // instrument() preserves existing wids (INV-1), only ADDS for untagged blocks; safe to
  // run after INV-2 has already passed. Without this, content added via structural-change
  // stays unclickable in the editor.
  const html = instrument(regenerated).html;
  atomicWrite(join(dir, `_v${version}.html`), html);
  ({ manifest } = recordVersion(manifest, { version, parent, feedbackFile: mdFile }));
  saveManifest(dir, manifest);

  if (typeof opts.emit === "function") {
    opts.emit("HTML_UPDATED", {
      document_id: opts.documentId ?? dir,
      version, html_file: `_v${version}.html`, prev_version: parent, ts: new Date().toISOString(),
    });
  }

  let awaiting_structural = 0;
  if (structural.length) {
    ({ count: awaiting_structural } = writeStructuralRequest(dir, {
      version, baseHtmlFile: `_v${version}.html`, structural, documentId: opts.documentId ?? dir,
    }));
  }
  return { version, html_file: `_v${version}.html`, applied, rejected, stale, awaiting_structural };
}
