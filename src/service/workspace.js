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

import { mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { instrument } from "../core/instrument.js";
import { parseFeedback, serializeFeedback } from "../core/feedback-schema.js";
import { regenerate } from "../core/regenerate.js";
import { initManifest, recordVersion, getVersion, nextVersionNumber } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest, readVersionHtml } from "./fsstore.js";
import { splitItems, extractFragment } from "./structural.js";
import { themed } from "./theme-source.js";

// Re-export the store reads so existing callers (server, tests) keep their import path.
export { loadManifest, readVersionHtml } from "./fsstore.js";

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
 * opts.instrument === false), writes _v0.html, and seeds the manifest (`opts.kind`,
 * `opts.style` — the requested output format — are recorded on it).
 */
export function initWorkspace(dir, html, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const anchored = opts.instrument === false ? html : instrument(html).html;
  // Apply the in-repo base theme so every version (including v0) shares a consistent
  // look (ADR-0016 Slice C). Idempotent + anchor-free, so INV-1/INV-2 are unaffected.
  const prepared = themed(anchored, opts);
  atomicWrite(join(dir, "_v0.html"), prepared);
  const manifest = initManifest("_v0.html", { kind: opts.kind, style: opts.style });
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
  return { version, file, parent: manifest.head };
}

/**
 * Event-native core (ADR-0019): apply the DETERMINISTIC edits for a feedback batch, land the
 * partial _v{n}.html write-once, record the version, and RETURN the structural items (with
 * their freshly-extracted fragments) for the agent to fulfil — instead of writing a request
 * file. Pure: no emit, no bus. Idempotent on (version): a re-run for a version already in the
 * manifest is a no-op that still reports the (now-empty) structural set.
 *
 * NO PHANTOM VERSIONS (F-RECON-005): a version is minted only when the content actually changed.
 * A batch that is structural-only (or whose deterministic edits were all rejected/stale/no-ops)
 * regenerates byte-identical HTML; landing that as `_v{n}.html` produced a version the strip,
 * the export menu and the thread ("v3 landed") all offered while it changed nothing — and the
 * real edit then landed as v4. Now the unchanged batch lands NOTHING: `_v{n}.md` (the feedback,
 * already written by writeFeedback) keeps its reserved number, the returned `version` stays that
 * number (it is the handoff id the agent/crew edit is keyed on), `landed: false` /
 * `unchanged: true` / `base_version` say what happened, and the follow-on structural edit is the
 * version that gets the number (structural.applyStructuralResults resolves its base through the
 * feedback file). Content equality is a sha-256 of the prepared bytes.
 * @returns {Promise<{version,html_file,applied,rejected,stale,structural_items,landed,unchanged,base_version,feedback_file}>}
 */
export async function applyFeedbackItems(dir, { version, parent, items }, opts = {}) {
  let manifest = loadManifest(dir);
  if (getVersion(manifest, version) != null) {
    const existing = getVersion(manifest, version);
    return { version, html_file: existing.html_file, applied: [], rejected: [], stale: [], structural_items: [], idempotent: true, landed: true, unchanged: false, base_version: existing.parent };
  }
  const { deterministic, structural } = splitItems(items);
  const prevHtml = readVersionHtml(dir, parent);
  const { html: regenerated, applied, rejected, stale } = await regenerate(prevHtml, { items: deterministic }, {});
  // Re-instrument (adds wids to new blocks, INV-1 preserves existing) then re-theme
  // (idempotent), exactly as the legacy path — so a partial version stays clickable + themed.
  const html = themed(instrument(regenerated).html, opts);
  const feedback_file = `_v${version}.md`;
  // Extract each structural item's CURRENT fragment so the agent edits real markup (the data-wid
  // contract — ADR-0001 — rides in the fragment). When nothing landed, "current" is the base.
  const fragmentsFrom = (src) => structural.map((it) => ({
    selector: it.selector,
    instruction: it.instruction,
    fragment: extractFragment(src, it.selector),
  }));
  if (contentHash(html) === contentHash(prevHtml)) {
    return {
      version, html_file: `_v${parent}.html`, applied, rejected, stale,
      structural_items: fragmentsFrom(prevHtml),
      landed: false, unchanged: true, base_version: parent, feedback_file,
    };
  }
  atomicWrite(join(dir, `_v${version}.html`), html);
  ({ manifest } = recordVersion(manifest, { version, parent, feedbackFile: feedback_file }));
  saveManifest(dir, manifest);
  return {
    version, html_file: `_v${version}.html`, applied, rejected, stale,
    structural_items: fragmentsFrom(html),
    landed: true, unchanged: false, base_version: parent, feedback_file,
  };
}

/** sha-256 of the prepared bytes — the "did the content change" test (F-RECON-005). */
export function contentHash(html) {
  return createHash("sha256").update(String(html)).digest("hex");
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

