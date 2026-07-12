// structural.js — apply the agent's structural-change edits as a follow-on version (ADR-0019).
//
// The agent receives the structural items inline on `wicked.interactive.feedback.processed` and emits its
// edited fragments back on `wicked.interactive.edit.completed`; the service applies them through the INV-2
// gate, producing a follow-on version (write-once, INV-4). `extractFragment` + `splitItems`
// are the shared helpers the feedback path uses to pull current markup for the agent.

import * as cheerio from "cheerio";
import { join } from "node:path";
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
 * Apply the agent's structural results (from a `wicked.interactive.edit.completed` event) as a follow-on
 * version. The INV-2 gate (in regenerate) rejects any fragment that dropped a data-wid.
 * Result shape: { version (the parent), results: [{selector, fragment} | {selector, remove:true}] }.
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
  return { version: newVersion, parent, applied, rejected };
}
