// regenerate.js — determinism-first hybrid regeneration engine (ADR-0003).
//
// content-edit / style-edit  -> cheerio DOM surgery, no LLM.
// structural-change          -> fragment-scoped LLM (opts.llm), increment 4.
//
// Guardrails:
//   INV-2  every data-wid present in the input survives (per-item, revert on violation;
//          plus a global safety net that throws).
//   INV-3  only elements named in the feedback change; untargeted elements are untouched
//          by construction (we mutate only the matched element).
//   AC-10  stale-target detection: if `before` no longer matches, skip + flag.

import * as cheerio from "cheerio";
import { collectWids } from "./instrument.js";

export class Inv2Error extends Error {
  constructor(missing) {
    super(`INV-2 violation: data-wid(s) dropped during regeneration: ${missing.join(", ")}`);
    this.name = "Inv2Error";
    this.missing = missing;
  }
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function widsUnder($, el) {
  const out = [];
  const own = $(el).attr("data-wid");
  if (own) out.push(own);
  $(el).find("[data-wid]").each((_, c) => out.push($(c).attr("data-wid")));
  return out;
}

function applyStyle($el, styleMap) {
  const existing = ($el.attr("style") || "")
    .split(";").map((s) => s.trim()).filter(Boolean)
    .reduce((acc, decl) => {
      const i = decl.indexOf(":");
      if (i > 0) acc[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
      return acc;
    }, {});
  for (const [k, v] of Object.entries(styleMap)) existing[k] = String(v);
  const serialized = Object.entries(existing).map(([k, v]) => `${k}: ${v}`).join("; ");
  $el.attr("style", serialized);
}

/**
 * Apply a parsed feedback object to the previous HTML, producing the next version.
 * @param {string} prevHtml
 * @param {{ items: Array<object> }} feedback
 * @param {object} [opts]
 * @param {(fragmentHtml: string, instruction: string) => Promise<string>} [opts.llm]
 * @returns {Promise<{ html: string, applied: string[], rejected: Array<{selector:string,reason:string}>, stale: string[] }>}
 */
export async function regenerate(prevHtml, feedback, opts = {}) {
  const $ = cheerio.load(prevHtml, null, false);
  const prevIds = collectWids(prevHtml);
  const applied = [];
  const rejected = [];
  const stale = [];
  const removed = [];  // anchors intentionally deleted (exempt from the INV-2 net)

  for (const item of feedback.items) {
    const $el = $(`[data-wid="${item.selector}"]`);
    if ($el.length === 0) {
      rejected.push({ selector: item.selector, reason: "selector-not-found" });
      continue;
    }
    const el = $el[0];

    // AC-10 stale-target check.
    if (item.before != null && norm($el.text()) !== norm(item.before)) {
      stale.push(item.selector);
      continue;
    }

    if (item.type === "content-edit") {
      const prevInner = $el.html();
      const before = widsUnder($, el);
      $el.html(item.value);
      const after = widsUnder($, el);
      const dropped = before.filter((w) => !after.includes(w));
      if (dropped.length) {
        $el.html(prevInner); // revert
        rejected.push({ selector: item.selector, reason: `inv2-would-drop-wids:${dropped.join(",")}` });
        continue;
      }
      applied.push(item.selector);
    } else if (item.type === "style-edit") {
      if (item.style) applyStyle($el, item.style);
      if (item.class_remove) item.class_remove.forEach((c) => $el.removeClass(c));
      if (item.class_add) item.class_add.forEach((c) => $el.addClass(c));
      applied.push(item.selector);
    } else if (item.type === "remove") {
      // Explicit structural removal (ADR-0003): the element and its subtree anchors go,
      // and they're exempted from the INV-2 net below (this is intentional, not a drop).
      removed.push(...widsUnder($, el));
      $el.remove();
      applied.push(item.selector);
    } else if (item.type === "structural-change") {
      if (typeof opts.llm !== "function") {
        rejected.push({ selector: item.selector, reason: "structural-change-requires-llm" });
        continue;
      }
      const fragmentBefore = $.html($el);
      const subtreeBefore = widsUnder($, el);
      let newFragment;
      try {
        newFragment = await opts.llm(fragmentBefore, item.instruction);
      } catch (e) {
        rejected.push({ selector: item.selector, reason: `llm-error:${e.message}` });
        continue;
      }
      $el.replaceWith(newFragment);
      // INV-2 for the LLM path: every wid in the fragment must survive.
      const newSub = collectWids(newFragment);
      const dropped = subtreeBefore.filter((w) => !newSub.includes(w));
      if (dropped.length) {
        // INV-2 violation on the LLM path: re-run without the offending item so the
        // rest of the batch still applies, and the bad item is reported as rejected.
        return regenerateExcluding(prevHtml, feedback, opts, item.selector);
      }
      applied.push(item.selector);
    }
  }

  const html = $.html();
  const present = collectWids(html);
  const missing = prevIds.filter((w) => !present.includes(w) && !removed.includes(w));
  if (missing.length) throw new Inv2Error(missing); // safety net — per-item guards should prevent this
  return { html, applied, rejected, stale };
}

// On an LLM INV-2 violation, re-run without the offending item so the rest still apply.
async function regenerateExcluding(prevHtml, feedback, opts, badSelector) {
  const filtered = { ...feedback, items: feedback.items.filter((i) => i.selector !== badSelector) };
  const res = await regenerate(prevHtml, filtered, opts);
  res.rejected.push({ selector: badSelector, reason: "inv2-llm-dropped-wids (excluded)" });
  return res;
}
