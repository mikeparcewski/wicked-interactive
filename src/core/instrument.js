// instrument.js — inject stable data-wid anchors into HTML (ADR-0001).
//
// data-wid format: `slide-{slideIndex}-{role}-{ordinal}`
//   slideIndex — 0-based index of the nearest ancestor slide container
//                (`section`, `[data-slide]`, `.slide`); 0 when there is none.
//   role       — derived from the tag (heading / paragraph / list-item / ...).
//   ordinal    — 1-based counter per (slideIndex, role).
//
// Stability (INV-1): an element that already carries a data-wid keeps it.

import * as cheerio from "cheerio";

export const DEFAULT_REVIEWABLE = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "li", "blockquote", "figcaption",
  "td", "th", "a", "button", "img",
];

const ROLE_BY_TAG = {
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  p: "paragraph", li: "list-item", blockquote: "quote", figcaption: "caption",
  td: "cell", th: "cell", a: "link", button: "button", img: "image",
};

const SLIDE_SELECTOR = "section, [data-slide], .slide";
// Containers that can be restyled/themed as a whole (ADR-0011).
const SECTION_SELECTOR = "section, header, [data-slide], .slide";

function roleFor(tagName) {
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
    const role = roleFor(el.tagName || el.name);
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

  return { html: $.html(), ids, sectionIds };
}

/** All data-wid values present in an HTML string, in document order. */
export function collectWids(html) {
  const $ = cheerio.load(html, null, false);
  return $("[data-wid]").map((_, el) => $(el).attr("data-wid")).toArray();
}
