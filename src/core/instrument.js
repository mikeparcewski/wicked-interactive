// instrument.js — inject stable data-wid anchors into HTML (ADR-0001).
//
// data-wid format: `slide-{slideIndex}-{role}-{ordinal}`
//   slideIndex — 0-based index of the nearest ancestor slide container
//                (`section`, `[data-slide]`, `.slide`); 0 when there is none.
//   role       — derived from the tag (heading / paragraph / list-item / ...).
//   ordinal    — 1-based counter per (slideIndex, role).
//
// Stability (INV-1): an element that already carries a data-wid keeps it.
//
// EVERY TEXT BLOCK IS ANCHORABLE (F-RECON-004). The reviewable list below covers the semantic
// tags (h*, p, li, td, …); real documents also carry text in plain containers — a hero fact strip
// (`div > span…`), a footer requirements block, flow badges, KPI tiles. Those had no anchor, so a
// comment pinned on the strip resolved to the nearest anchored block (the hero paragraph) and the
// design edit landed, with perfect anchor fidelity, on the WRONG block. A second pass now anchors
// every "text block" — an element with visible text whose text is its own or lives in inline
// children (no block-level child carries text) — that is not already inside an anchored block.
// Roles: `block` for block-level tags, `text` for inline ones. Strictly additive: the semantic
// ids are unchanged (own counters), pre-existing ids are preserved, section anchors stay
// `section-{i}`, decorative (`aria-hidden`) nodes and author opt-outs (`data-wi-no-anchor`) are
// skipped.

import * as cheerio from "cheerio";

export const DEFAULT_REVIEWABLE = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "blockquote", "figcaption",
  "td", "th", "a", "button", "img",
  // Author opt-in for composite cards (divs) and chiclets (spans). Anything tagged
  // `data-card` becomes individually clickable and gets its own data-wid — without
  // this, structural-change content (cards, chips, tiles) stays unreachable.
  "[data-card]",
];

const ROLE_BY_TAG = {
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  p: "paragraph", li: "list-item", blockquote: "quote", figcaption: "caption",
  td: "cell", th: "cell", a: "link", button: "button", img: "image",
};

const SLIDE_SELECTOR = "section, [data-slide], .slide";
// Containers that can be restyled/themed as a whole (ADR-0011).
const SECTION_SELECTOR = "section, header, [data-slide], .slide";

// Block-level tags (a child of these kinds that carries text makes its parent a CONTAINER, not
// a text block); everything else is treated as inline (span, a, b, em, code, small, …).
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "html", "legend", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
]);
// Never anchored, never counted as visible text.
const SKIP_TAGS = new Set([
  "script", "style", "template", "noscript", "svg", "math", "head", "title", "meta", "link", "base", "br", "hr",
  "wbr", "img", "picture", "source", "track", "video", "audio", "canvas", "iframe", "object", "embed", "input",
  "select", "option", "optgroup", "textarea", "html", "body", "main",
]);
// Author opt-out for a container that must stay un-anchored (decorative chrome).
const NO_ANCHOR_ATTR = "data-wi-no-anchor";
const isElement = (n) => n && n.type === "tag";
const tagOf = (el) => String(el.tagName || el.name || "").toLowerCase();
const hiddenFromReaders = (el) => el.attribs && (el.attribs["aria-hidden"] === "true" || "hidden" in el.attribs);

/** Own text nodes (direct children only), trimmed. */
function ownText(el) {
  let t = "";
  for (const c of el.children || []) if (c.type === "text") t += c.data || "";
  return t.trim();
}
/** Visible text of an element and its descendants (skips script/style-like nodes and reader-hidden nodes). */
function visibleText(el) {
  if (!isElement(el) || SKIP_TAGS.has(tagOf(el)) || hiddenFromReaders(el)) return "";
  let t = "";
  for (const c of el.children || []) {
    if (c.type === "text") t += c.data || "";
    else if (isElement(c)) t += visibleText(c);
  }
  return t.trim();
}
/** A text block: has visible text, and either its own text or no block-level child carrying text. */
function isTextBlock(el) {
  if (!visibleText(el)) return false;
  if (ownText(el)) return true;
  for (const c of el.children || []) {
    if (isElement(c) && BLOCK_TAGS.has(tagOf(c)) && visibleText(c)) return false;
  }
  return true;
}

function roleFor(el) {
  // `data-card` is explicit author intent — keep its own role so cards (divs) and
  // chiclets (spans) end up with predictable, semantic wids like `slide-3-card-2`.
  if (el?.attribs && el.attribs["data-card"] != null) return "card";
  const tagName = el?.tagName || el?.name;
  return ROLE_BY_TAG[tagName] || "block";
}

/**
 * Instrument an HTML string with data-wid attributes.
 * @param {string} html
 * @param {object} [opts]
 * @param {string[]} [opts.reviewable] selectors considered reviewable blocks
 * @returns {{ html: string, ids: string[] }}
 */
export function instrument(html, opts = {}) {
  const reviewable = opts.reviewable || DEFAULT_REVIEWABLE;
  const $ = cheerio.load(html, null, false);

  // Index slide containers in document order.
  const slides = $(SLIDE_SELECTOR).toArray();
  const slideIndex = new Map();
  slides.forEach((el, i) => slideIndex.set(el, i));

  function nearestSlide(el) {
    let cur = el.parent;
    while (cur) {
      if (slideIndex.has(cur)) return slideIndex.get(cur);
      cur = cur.parent;
    }
    return 0;
  }

  const counters = new Map(); // `${slide}-${role}` -> n
  const seen = new Set();     // pre-existing ids (preserve, avoid collision)
  $("[data-wid]").each((_, el) => seen.add($(el).attr("data-wid")));

  const ids = [];
  $(reviewable.join(",")).each((_, el) => {
    const $el = $(el);
    const existing = $el.attr("data-wid");
    if (existing) {
      ids.push(existing);
      return; // INV-1: never reassign
    }
    const slide = nearestSlide(el);
    const role = roleFor(el);
    const key = `${slide}-${role}`;
    let n = (counters.get(key) || 0) + 1;
    let wid = `slide-${slide}-${role}-${n}`;
    while (seen.has(wid)) {
      n += 1;
      wid = `slide-${slide}-${role}-${n}`;
    }
    counters.set(key, n);
    seen.add(wid);
    $el.attr("data-wid", wid);
    ids.push(wid);
  });

  // Second pass (F-RECON-004): anchor every remaining TEXT BLOCK so nothing with words on it
  // is un-pinnable. Document order, so a parent that qualifies (a `div` of `span`s) is anchored
  // and its inline children are then skipped as "inside an anchored block". Section containers
  // are left to the section pass below; anything inside an already-anchored block (the `<b>`
  // in a `<p>`, the spans of the strip) is skipped — nesting stays at the semantic level.
  const sectionEls = new Set($(SECTION_SELECTOR).toArray());
  const insideAnchoredBlock = (el) => {
    let cur = el.parent;
    while (cur) {
      if (isElement(cur) && !sectionEls.has(cur) && cur.attribs && cur.attribs["data-wid"]) return true;
      cur = cur.parent;
    }
    return false;
  };
  $("*").each((_, el) => {
    if (!isElement(el) || el.attribs["data-wid"] != null) return;
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag) || sectionEls.has(el) || hiddenFromReaders(el) || el.attribs[NO_ANCHOR_ATTR] != null) return;
    if (insideAnchoredBlock(el) || !isTextBlock(el)) return;
    const slide = nearestSlide(el);
    const role = BLOCK_TAGS.has(tag) ? "block" : "text";
    const key = `${slide}-${role}`;
    let n = (counters.get(key) || 0) + 1;
    let wid = `slide-${slide}-${role}-${n}`;
    while (seen.has(wid)) { n += 1; wid = `slide-${slide}-${role}-${n}`; }
    counters.set(key, n);
    seen.add(wid);
    $(el).attr("data-wid", wid);
    ids.push(wid);
  });

  // Anchor section/slide containers (ADR-0011). Additive: a `section-{i}` namespace that
  // never collides with the `slide-...` block ids, and pre-existing ids are preserved.
  const sectionIds = [];
  let sec = 0;
  $(SECTION_SELECTOR).each((_, el) => {
    const $el = $(el);
    const existing = $el.attr("data-wid");
    if (existing) { sectionIds.push(existing); return; }
    let wid = `section-${sec}`;
    while (seen.has(wid)) { sec += 1; wid = `section-${sec}`; }
    sec += 1;
    seen.add(wid);
    $el.attr("data-wid", wid);
    sectionIds.push(wid);
  });

  // `ids` = EVERY block anchor present after instrumentation (non-section elements, document
  // order) — assigned or preserved alike — so re-instrumenting an instrumented document
  // returns the same array as the first pass, not just the ids the semantic pass touched.
  const blockIds = [];
  $("[data-wid]").each((_, el) => { if (!sectionEls.has(el)) blockIds.push($(el).attr("data-wid")); });

  return { html: $.html(), ids: blockIds, sectionIds };
}

/**
 * Every element with visible text that has NO anchored block on its self-or-ancestor chain
 * (section containers excluded) — i.e. text a comment pin cannot land on. Empty after
 * `instrument()`; exported so the invariant is testable against any rendered document.
 * @returns {string[]} outerHTML openings of the offending elements (first 120 chars each)
 */
export function unanchoredTextBlocks(html) {
  const $ = cheerio.load(html, null, false);
  const sectionEls = new Set($(SECTION_SELECTOR).toArray());
  const out = [];
  $("*").each((_, el) => {
    if (!isElement(el) || SKIP_TAGS.has(tagOf(el)) || hiddenFromReaders(el)) return;
    if (!ownText(el)) return;   // text lives in a descendant — that descendant is checked itself
    let cur = el;
    while (cur && isElement(cur)) {
      if (!sectionEls.has(cur) && cur.attribs && cur.attribs["data-wid"]) return;
      cur = cur.parent;
    }
    out.push($.html(el).slice(0, 120));
  });
  return out;
}

/** All data-wid values present in an HTML string, in document order. */
export function collectWids(html) {
  const $ = cheerio.load(html, null, false);
  return $("[data-wid]").map((_, el) => $(el).attr("data-wid")).toArray();
}
