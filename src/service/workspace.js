// workspace.js — a document workspace on disk and the feedback->regenerate pipeline.
//
// Layout (one directory per document):
//   _v0.html, _v1.html, ...   version artifacts (write-once, INV-4)
//   _v1.md, _v2.md, ...       feedback files (no _v0.md — v0 is the initial build)
//   versions.json             parent-pointer manifest (ADR-0008)
//
// The service is the SINGLE writer of feedback files (ADR-0002): writes are atomic
// (temp + rename) so the watcher never reads a half-written file.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { instrument } from "../core/instrument.js";
import { parseFeedback, serializeFeedback } from "../core/feedback-schema.js";
import { regenerate } from "../core/regenerate.js";
import { initManifest, recordVersion, getVersion, nextVersionNumber } from "../core/versions.js";

const MANIFEST = "versions.json";

function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on the same filesystem
}

export function loadManifest(dir) {
  return JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8"));
}

function saveManifest(dir, manifest) {
  atomicWrite(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
}

export function readVersionHtml(dir, version) {
  return readFileSync(join(dir, `_v${version}.html`), "utf-8");
}

const versionFromHtmlFile = (f) => Number(/_v(\d+)\.html$/.exec(f)?.[1]);

/**
 * Initialise a workspace from an HTML draft. Instruments it with data-wid (unless
 * opts.instrument === false), writes _v0.html, and seeds the manifest.
 * @returns {{ manifest: object }}
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
 * @returns {{ version: number, file: string }}
 */
export function writeFeedback(dir, { items, author }) {
  const manifest = loadManifest(dir);
  const base = getVersion(manifest, manifest.head);
  const version = nextVersionNumber(manifest);
  const feedback = {
    frontmatter: {
      version,
      base_html: base.html_file,
      timestamp: new Date().toISOString(),
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
 * Process a feedback file: regenerate the base HTML, write _v{n}.html, and record the
 * version in the manifest. Idempotent on (version) — re-processing an already-recorded
 * version is a no-op that returns the existing entry.
 * @returns {Promise<{version:number, html_file:string, applied:string[], rejected:object[], stale:string[]}>}
 */
export async function processFeedbackFile(dir, mdFile, opts = {}) {
  const md = readFileSync(join(dir, mdFile), "utf-8");
  const feedback = parseFeedback(md);
  const version = feedback.frontmatter.version;
  const parent = versionFromHtmlFile(feedback.frontmatter.base_html);

  let manifest = loadManifest(dir);
  if (getVersion(manifest, version) != null) {
    const existing = getVersion(manifest, version);
    return { version, html_file: existing.html_file, applied: [], rejected: [], stale: [], idempotent: true };
  }

  const prevHtml = readVersionHtml(dir, parent);
  const { html, applied, rejected, stale } = await regenerate(prevHtml, feedback, { llm: opts.llm });

  atomicWrite(join(dir, `_v${version}.html`), html);
  ({ manifest } = recordVersion(manifest, { version, parent, feedbackFile: mdFile }));
  saveManifest(dir, manifest);

  const emit = opts.emit;
  if (typeof emit === "function") {
    emit("HTML_UPDATED", {
      document_id: opts.documentId ?? dir,
      version,
      html_file: `_v${version}.html`,
      prev_version: parent,
      ts: new Date().toISOString(),
    });
  }
  return { version, html_file: `_v${version}.html`, applied, rejected, stale };
}
