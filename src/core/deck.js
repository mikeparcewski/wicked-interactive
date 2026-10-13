// deck.js — slide identity and the deterministic deck ops (DES-PRESENTATION-EDITOR-001 I-D1).
//
// A deck's slides are its TOP-LEVEL slide containers (`section`, `[data-slide]`, `.slide` with no
// slide container above them), in DOCUMENT ORDER. Each carries a stable `data-slide-id`, assigned
// once and never renumbered. The positional `section-{i}` / `slide-{i}-…` data-wid anchors stay
// rendering details: once a slide moves they no longer say where it is, so order is read from the
// document and identity from `data-slide-id`.
//
// Ids are derived from the slide's content when it is first seen (sha-256 of its text and tag
// structure with the anchors stripped, plus the occurrence index among identical slides). They are
// not random, so instrumenting the same HTML twice gives the same ids. This keeps the "no phantom
// versions" check (F-RECON-005) exact on a legacy deck that had no ids yet: a no-op batch on it
// compares equal to its re-instrumented base. Once assigned, an id is kept whatever the slide becomes.
//
// The ops (each lands as exactly one version through the feedback pipeline, regenerate.js):
//   slide-insert    {selector: <layout slide id>, after: <slide id> | ""}  a copy of the layout
//                   slide's structure with its text cleared, its anchors and notes dropped (fresh
//                   ones are assigned), placed after `after` ("" = first)
//   slide-duplicate {selector: <slide id>}                                  a copy with fresh ids,
//                   notes kept, placed right after the original
//   slide-move      {selector: <slide id>, after: <slide id> | ""}         moved, anchors kept
//   notes-set       {selector: <slide id>, value: <text>}                  the speaker notes, as
//                   TEXT in `<aside class="notes" data-notes-for hidden data-wi-no-anchor>` inside
//                   the slide; "" removes them
// Deleting a slide is the existing `remove` op on the slide's own data-wid.

import { createHash } from "node:crypto";

export const SLIDE_SELECTOR = "section, [data-slide], .slide";
export const SLIDE_ID_ATTR = "data-slide-id";
export const NOTES_SELECTOR = "aside.notes[data-notes-for]";
export const DECK_OPS = ["slide-insert", "slide-duplicate", "slide-move", "notes-set"];
/** The styles a deck is created with (POST /api/docs `style`); the exporter's set. */
export const DECK_STYLES = new Set(["ppt", "slides"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a document (its manifest) is a deck: created with a deck style. */
export function isDeckManifest(manifest) {
  return DECK_STYLES.has(manifest?.style);
}

/** True when an id can be named exactly in an attribute selector. */
export function isSafeSlideId(id) {
  return typeof id === "string" && SAFE_ID.test(id);
}

/** The deck's slides (top-level slide containers), in document order. */
// Elements with no content are never slides, whatever their class (the PPTX builder agrees — codex r2),
// and neither is a slide's speaker-notes aside (`aside[data-notes-for]`: the builder reads it as notes — codex r3).
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const isContainer = (el) => {
  const tag = String(el.tagName || el.name || "").toLowerCase();
  return !VOID_TAGS.has(tag) && !(tag === "aside" && el.attribs && el.attribs["data-notes-for"] !== undefined);
};

// Nothing inside a notes aside is a slide either: the builder reads all of it as notes text (codex r4).
export function topSlides($) {
  return $(SLIDE_SELECTOR).toArray().filter((el) => isContainer(el)
    && $(el).parents("aside[data-notes-for]").length === 0
    && $(el).parents(SLIDE_SELECTOR).filter((_, p) => isContainer(p)).length === 0);
}

/** A slide's identity-free shape: its tags and text, without anchors, ids, styles or notes. */
function slideShape($, el) {
  const c = $(el).clone();
  c.find(NOTES_SELECTOR).remove();
  const strip = (n) => {
    if (n.type !== "tag") return;
    for (const a of Object.keys(n.attribs || {})) if (a === "data-wid" || a === SLIDE_ID_ATTR || a === "style") delete n.attribs[a];
    for (const ch of n.children || []) strip(ch);
  };
  strip(c[0]);
  return $.html(c).replace(/\s+/g, " ").trim();
}

/**
 * Give every top-level slide without a `data-slide-id` one (content-derived, unique in the deck).
 * Mutates the cheerio document. Returns the ids in document order.
 */
export function assignSlideIds($) {
  const slides = topSlides($);
  // An id that cannot be named exactly, or that a slide before it already holds, is not an identity:
  // it is minted again (codex r1 on I-D1). Every other assigned id is kept.
  const taken = new Set();
  for (const el of slides) {
    const id = $(el).attr(SLIDE_ID_ATTR);
    if (id === undefined) continue;
    if (!isSafeSlideId(id) || taken.has(id)) $(el).removeAttr(SLIDE_ID_ATTR);
    else taken.add(id);
  }
  const occurrences = new Map();
  for (const el of slides) {
    if ($(el).attr(SLIDE_ID_ATTR)) continue;
    const shape = slideShape($, el);
    const n = occurrences.get(shape) ?? 0;
    occurrences.set(shape, n + 1);
    let salt = 0;
    let id;
    do {
      id = "s" + createHash("sha256").update(`${shape}\u0000${n}\u0000${salt}`).digest("hex").slice(0, 10);
      salt += 1;
    } while (taken.has(id));
    taken.add(id);
    $(el).attr(SLIDE_ID_ATTR, id);
  }
  return slides.map((el) => $(el).attr(SLIDE_ID_ATTR));
}

/** The top-level slide with this id, or null. */
function slideById($, id) {
  if (!isSafeSlideId(id)) return null;
  return topSlides($).find((el) => $(el).attr(SLIDE_ID_ATTR) === id) ?? null;
}

/** Drop every anchor and slide id in a cloned subtree, so instrumentation gives the copy fresh ones. */
function dropIds($, $c) {
  $c.removeAttr("data-wid").removeAttr(SLIDE_ID_ATTR);
  $c.find("[data-wid]").removeAttr("data-wid");
  $c.find(`[${SLIDE_ID_ATTR}]`).removeAttr(SLIDE_ID_ATTR);
}

/** Clear every text node in the subtree (structure, classes and media stay: the layout carries over). */
function clearText($, $c) {
  const walk = (n) => {
    for (const ch of n.children || []) {
      if (ch.type === "text") ch.data = "";
      else if (ch.type === "tag" && !["script", "style"].includes(ch.name)) walk(ch);
    }
  };
  walk($c[0]);
}

/** Place `$c` after the slide `after` ("" / null = before the first slide). */
function placeAfter($, $c, after) {
  if (after === "" || after == null) {
    const first = topSlides($)[0];
    if (first) $(first).before($c);
    else $.root().append($c);
    return true;
  }
  const anchor = slideById($, after);
  if (!anchor) return false;
  $(anchor).after($c);
  return true;
}

/**
 * Apply one deck op to the cheerio document. Returns `{ ok: true }` or `{ ok: false, reason }`;
 * nothing is changed on a refusal.
 */
export function applyDeckOp($, item) {
  const target = slideById($, item.selector);
  if (!target) return { ok: false, reason: "slide-not-found" };
  const after = item.after ?? null;
  if (after !== null && after !== "" && !slideById($, after)) return { ok: false, reason: "after-slide-not-found" };
  switch (item.type) {
    case "slide-insert": {
      const $c = $(target).clone();
      $c.find(NOTES_SELECTOR).remove();
      dropIds($, $c);
      clearText($, $c);
      placeAfter($, $c, after);
      return { ok: true };
    }
    case "slide-duplicate": {
      const $c = $(target).clone();
      dropIds($, $c);
      $c.find(NOTES_SELECTOR).removeAttr("data-notes-for");
      $(target).after($c);
      // The copy's notes are re-pointed once its id is assigned (see linkNotes).
      return { ok: true };
    }
    case "slide-move": {
      if (after === item.selector) return { ok: false, reason: "after-is-the-slide" };
      // Already there: nothing is touched (codex r1 — removing the only slide, then placing it "first",
      // used to re-parent it at the document root).
      const order = topSlides($);
      const at = order.indexOf(target);
      const prev = at > 0 ? $(order[at - 1]).attr(SLIDE_ID_ATTR) : null;
      if ((after === null || after === "") ? at === 0 : prev === after) return { ok: true };
      const $t = $(target);
      $t.remove();
      placeAfter($, $t, after);
      return { ok: true };
    }
    case "notes-set": {
      const text = String(item.value ?? "");
      const $t = $(target);
      // Only the slide's OWN notes (a nested slide's are its own).
      const own = $t.find(NOTES_SELECTOR).toArray().filter((n) => $(n).parents(SLIDE_SELECTOR).first()[0] === target);
      // Notes that carry review anchors (written before I-D1) cannot be replaced without dropping them
      // (INV-2): refused as an item, so the rest of a batch still lands (codex r1).
      if (own.some((n) => $(n).is("[data-wid]") || $(n).find("[data-wid]").length > 0)) return { ok: false, reason: "notes-hold-anchors" };
      if (text.trim() === "") { for (const n of own) $(n).remove(); return { ok: true }; }
      let $n = own.length > 0 ? $(own[0]) : null;
      for (const extra of own.slice(1)) $(extra).remove();
      if ($n === null) {
        $n = $("<aside></aside>").addClass("notes");
        $t.append($n);
      }
      $n.attr("data-notes-for", item.selector).attr("hidden", "").attr("data-wi-no-anchor", "");
      $n.text(text); // TEXT, never markup (#247)
      return { ok: true };
    }
    default:
      return { ok: false, reason: `not-a-deck-op:${item.type}` };
  }
}

/** Point every slide's notes at the slide's own id (a duplicate's notes, after its id is minted). */
export function linkNotes($) {
  for (const el of topSlides($)) {
    const id = $(el).attr(SLIDE_ID_ATTR);
    if (!id) continue;
    $(el).find(NOTES_SELECTOR.replace("[data-notes-for]", "")).each((_, n) => {
      if ($(n).parents(SLIDE_SELECTOR).first()[0] === el) $(n).attr("data-notes-for", id);
    });
  }
}

/** The deck as data: `[{ id, notes }]` in document order (what a client or the exporter reads). */
export function deckOutline($) {
  return topSlides($).map((el) => {
    const notes = $(el).find(NOTES_SELECTOR).toArray().filter((n) => $(n).parents(SLIDE_SELECTOR).first()[0] === el);
    return { id: $(el).attr(SLIDE_ID_ATTR) ?? null, notes: notes.length ? $(notes[0]).text() : "" };
  });
}
