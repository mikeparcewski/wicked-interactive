// structural.js — delegate structural-change edits to the supervising agent (ADR-0010).
//
// The service writes requests/_v{n}.request.json; the agent edits each fragment
// (preserving data-wid) and writes requests/_v{n}.response.json; the service applies the
// response through the INV-2 gate, producing a follow-on version (write-once, INV-4).

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { regenerate } from "../core/regenerate.js";
import { instrument } from "../core/instrument.js";
import { themed } from "./theme-source.js";
import { recordVersion, nextVersionNumber } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest, readVersionHtml } from "./fsstore.js";

export const REQUESTS_DIR = "requests";

/** Partition feedback items into the two engine paths. */
export function splitItems(items) {
  const deterministic = [];
  const structural = [];
  for (const it of items) (it.type === "structural-change" ? structural : deterministic).push(it);
  return { deterministic, structural };
}

/** The serialized current outerHTML of the element a structural item targets. */
export function extractFragment(html, selector) {
  const $ = cheerio.load(html, null, false);
  const el = $(`[data-wid="${selector}"]`);
  return el.length ? $.html(el) : null;
}

const rootWid = (fragmentHtml) => {
  const $ = cheerio.load(fragmentHtml, null, false);
  return $("[data-wid]").first().attr("data-wid") || null;
};

/**
 * Write the structural work request for version `version` (the partial). Each item gets
 * its current fragment extracted from the partial HTML so the agent edits the real markup.
 * @returns {{ requestFile: string, count: number }}
 */
export function writeStructuralRequest(dir, { version, baseHtmlFile, structural, documentId = dir }) {
  mkdirSync(join(dir, REQUESTS_DIR), { recursive: true });
  const html = readFileSync(join(dir, baseHtmlFile), "utf-8");
  const items = structural.map((it) => ({
    selector: it.selector,
    instruction: it.instruction,
    fragment: extractFragment(html, it.selector),
  }));
  const requestFile = `_v${version}.request.json`;
  const body = { document_id: documentId, version, base_html: baseHtmlFile, items };
  atomicWrite(join(dir, REQUESTS_DIR, requestFile), JSON.stringify(body, null, 2));
  return { requestFile, count: items.length };
}

/**
 * Apply an agent response: finalize the structural edits as a follow-on version.
 * Response shape: { version, results: [{ selector, fragment }] }.
 * The INV-2 gate (in regenerate) rejects any fragment that dropped a data-wid.
 * @returns {Promise<{version:number, parent:number, applied:string[], rejected:object[]}>}
 */
export async function applyStructuralResponse(dir, responseFile, opts = {}) {
  const resp = JSON.parse(readFileSync(join(dir, REQUESTS_DIR, responseFile), "utf-8"));
  return applyStructuralResults(dir, { version: resp.version, results: resp.results }, { ...opts, feedbackFile: responseFile });
}

/**
 * Event-native core (ADR-0019): apply the agent's structural results (from a
 * `wicked.edit.completed` event) as a follow-on version. Same INV-2 gate as the file path.
 * Result shape: { version (the parent partial), results: [{selector, fragment} | {selector, remove:true}] }.
 * @returns {Promise<{version:number, parent:number, applied:string[], rejected:object[]}>}
 */
export async function applyStructuralResults(dir, { version, results }, opts = {}) {
  const parent = version;
  const bySelector = new Map(results.map((r) => [r.selector, r.fragment]));
  const baseHtml = readVersionHtml(dir, parent);
  const feedback = {
    items: results.map((r) => (r.remove
      ? { selector: r.selector, type: "remove" }
      : { selector: r.selector, type: "structural-change", instruction: "(delegated)" })),
  };
  const llm = async (fragmentBefore) => {
    const sel = rootWid(fragmentBefore);
    const frag = bySelector.get(sel);
    if (frag == null) throw new Error(`no agent result for ${sel}`);
    return frag;
  };

  const { html: regenerated, applied, rejected } = await regenerate(baseHtml, feedback, { llm });
  // Re-instrument so any new h2/p/li in the structural fragment pick up a data-wid.
  // Without this, new content from the agent stays unclickable in the editor — INV-1
  // still preserves existing wids, INV-2 already passed inside regenerate, so this is
  // strictly additive.
  // Re-apply the base theme (idempotent) so agent-produced versions stay themed (ADR-0016
  // Slice C). Anchor-free, so the INV-2 gate that just passed is unaffected.
  const html = themed(instrument(regenerated).html, opts);

  let manifest = loadManifest(dir);
  const newVersion = nextVersionNumber(manifest);
  atomicWrite(join(dir, `_v${newVersion}.html`), html);
  ({ manifest } = recordVersion(manifest, { version: newVersion, parent, feedbackFile: opts.feedbackFile ?? null }));
  saveManifest(dir, manifest);

  if (typeof opts.emit === "function") {
    opts.emit("HTML_UPDATED", {
      document_id: opts.documentId ?? dir,
      version: newVersion, html_file: `_v${newVersion}.html`, prev_version: parent, ts: new Date().toISOString(),
    });
  }
  return { version: newVersion, parent, applied, rejected };
}
