// export.js — export a version to a self-contained interactive HTML or a PDF (ADR-0009).
//
// HTML: inline local stylesheets, scripts, images (data-URI), and url() refs inside inlined
//       CSS, so the file renders + stays interactive opened straight from disk (no server).
//       The deliverable carries the author's markup and CSS AS AUTHORED — the only additions
//       are a document head (doctype / charset / viewport). No print rules are injected.
// PDF:  render a PDF-prep copy of that HTML via headless Chrome (the same primitive the
//       absorbed prezzie export pipeline used — ADR-0020). Print rules are injected into the
//       PDF-prep copy ONLY, and page geometry only for a document that DECLARES itself a deck.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import * as cheerio from "cheerio";
import { readVersionHtml, loadManifest } from "./fsstore.js";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".css": "text/css", ".js": "application/javascript",
};
const ext = (p) => { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i).toLowerCase(); };
const isLocal = (url) => url && !/^(https?:)?\/\//.test(url) && !url.startsWith("data:") && !url.startsWith("#");

function dataUri(absPath) {
  const mime = MIME[ext(absPath)] || "application/octet-stream";
  return `data:${mime};base64,${readFileSync(absPath).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Print contract (issue #12, re-scoped by F-050).
//
// `chrome --print-to-pdf` (new headless) lays the page out for print with no scroll and no
// animation clock, so screen-only reveal patterns render invisible. A few print rules make a
// render faithful; they are injected into the PDF-PREP copy only — never into the HTML a
// customer downloads, which must print from any browser exactly as its author wrote it.
//
// Two layouts, decided by `classifyLayout`:
//  - "document": the author owns the page geometry. We add nothing that changes it — no
//    `@page`, no forced heights, no page breaks. Only the render-safety baseline below.
//  - "deck": the author DECLARED a slide deck (see classifyLayout). We add the 16:9 `@page`
//    and one-slide-per-page geometry the deck formats rely on, plus the deck baseline.
// ---------------------------------------------------------------------------

// RENDER-SAFETY baseline — injected into the PDF-prep copy of EVERY export. Nothing here
// changes geometry or the author's look on a static page:
//  - print-color-adjust:exact keeps dark backgrounds + gradient FILLS in the render.
//  - COMPLETED-STATE (issue: blank/partial PDFs). Decks and web docs animate content in on
//    the SCREEN — scroll-reveals and step-builds hide elements with opacity/visibility/
//    transform until shown, and looping animations spin forever. In PRINT there is no scroll
//    and no keyframe clock, so that content renders INVISIBLE or frozen mid-spin. Force every
//    animation/transition off and the common reveal/step patterns to their COMPLETED, visible
//    state. A static document has nothing matching these selectors.
const PRINT_RENDER_SAFETY_CSS = [
  "@media print {",
  "  * { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }",
  "  *, *::before, *::after { animation: none !important; transition: none !important; }",
  "  [data-step], [data-reveal], [data-animate], [data-anim], [data-aos],",
  "  [class*=\"reveal\"], [class*=\"animate\"], [class*=\"fade\"], [class*=\"-rv\"],",
  "  [class*=\"slide-in\"], [class*=\"build\"], .is-hidden, .is-out {",
  "    opacity: 1 !important; visibility: visible !important; transform: none !important;",
  "  }",
  "}",
].join("\n");

// DECK baseline — the look-normalizing rules the slide formats were tuned against (issue #12
// gotchas #3/#4): glows off, gradient-clipped runs painted solid. Decks only: on a document
// these would repaint the author's design (a brochure's gradient headline printed plain).
const PRINT_DECK_BASELINE_CSS = [
  "@media print {",
  "  * { box-shadow: none !important; text-shadow: none !important; }",
  // Any run that clipped a gradient to its glyphs: paint it solid instead.
  "  [style*=\"-webkit-background-clip\"], [style*=\"background-clip\"],",
  "  [style*=\"text-fill-color\"] {",
  "    background: none !important; -webkit-background-clip: border-box !important;",
  "    background-clip: border-box !important; -webkit-text-fill-color: currentColor !important;",
  "    color: inherit !important;",
  "  }",
  "}",
].join("\n");

// DECK GEOMETRY — only for a DECLARED deck that has not declared its own page geometry.
// 13.333in x 7.5in == 960x540pt == 16:9. We target `.wi-slide-top`, a class decorateForExport
// stamps onto ONLY the top-level slide containers — a NESTED <section>/.slide (a sub-layout,
// tabs, or an inner card) must NOT be forced to 100vh/overflow:hidden or its content would
// clip. The geometry declarations carry !important so an author class rule can't silently
// override one-slide-per-page. (@page declarations don't take !important.)
export const DECK_PAGE_SIZE = "13.333in 7.5in";
const PRINT_DECK_PAGE_CSS = [
  "@media print {",
  `  @page { size: ${DECK_PAGE_SIZE}; margin: 0; }`,
  "}",
].join("\n");
// One slide per page. The body margin reset rides HERE (not with @page): a 100vh slide only
// fits its page when the body adds nothing, whichever @page — ours or the author's — is in force.
const PRINT_DECK_SLIDES_CSS = [
  "@media print {",
  "  html, body { margin: 0; padding: 0; }",
  "  .wi-slide-top {",
  "    min-height: 100vh !important; height: 100vh !important; box-sizing: border-box;",
  "    break-after: page !important; page-break-after: always; overflow: hidden !important;",
  "    display: flex !important; flex-direction: column; justify-content: center !important;",
  "  }",
  "  .wi-slide-top:last-child {",
  "    break-after: auto !important; page-break-after: auto;",
  "  }",
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// Layout classification (F-050).
// ---------------------------------------------------------------------------

/** Elements that DECLARE a slide: the tool's own `.wi-slide` (formats/ppt.md), the generic
 *  `.slide`, or `[data-slide]`. A plain semantic `<section>` is NOT a slide — the web and doc
 *  formats are built from thematic sections, and a brochure is sections inside `.page`s. */
export const SLIDE_MARKER_SELECTOR = "[data-slide], .slide, .wi-slide";
/** A document-level declaration that the whole file is a deck (any element, usually <html>/<body>). */
export const DECK_KIND_SELECTOR = '[data-wi-kind="deck"]';
/** Author page wrappers: the tool's own `.wi-page` (formats/brochure.md), the generic `.page`, `[data-page]`. */
export const PAGE_WRAPPER_SELECTOR = ".page, .wi-page, [data-page]";
/** Recorded doc styles (POST /api/docs `style`) that are documents, never decks. */
export const DOCUMENT_STYLES = new Set(["web", "doc", "brochure"]);
/** Recorded doc styles that declare a deck. */
export const DECK_STYLES = new Set(["ppt", "slides"]);

/**
 * The `layout_source` vocabulary — which rule decided the layout (reported on the export
 * response + `wicked.interactive.export.generated`). Diagnostic, human-readable, stable:
 *  - `style: <web|doc|brochure>`      recorded document style (rule 1)
 *  - `style: <ppt|slides>`            recorded deck style — an EXPLICIT deck (rule 2)
 *  - `declared data-wi-kind="deck"`   document-level deck marker — an EXPLICIT deck (rule 2)
 *  - `author @page`                   author-declared page size, no explicit deck (rule 3)
 *  - `declared slides (N × <markers>)` 2+ slide markers at document level (rule 4)
 *  - `author page breaks`             no deck; author paginates with wrappers/breaks (rule 5)
 *  - `no deck declaration`            no deck, nothing declared — natural flow (rule 5)
 *  - `format: pptx`                   a PPTX export (always a deck; set by the export route)
 */
export const LAYOUT_SOURCES = Object.freeze({
  documentStyle: (style) => `style: ${style}`,
  deckStyle: (style) => `style: ${style}`,
  deckKind: 'declared data-wi-kind="deck"',
  authorAtPage: "author @page",
  declaredSlides: (n) => `declared slides (${n} × ${SLIDE_MARKER_SELECTOR})`,
  authorPageBreaks: "author page breaks",
  none: "no deck declaration",
});

// `@page` as an at-rule — not `@page-foo`, and only in print-scoped CSS (see printScopedCss).
const AUTHOR_AT_PAGE = /@page(?![\w-])/i;
const AUTHOR_PAGE_BREAK = /(?:^|[\s;{])(?:break-(?:before|after)\s*:\s*(?:page|left|right|recto|verso|always)|page-break-(?:before|after)\s*:\s*always)/i;
// `@page { size: <value>; ... }` — the author's declared page size, first rule wins.
const AT_PAGE_SIZE = /@page(?![\w-])[^{]*\{[^}]*?\bsize\s*:\s*([^;}]+)/i;
// Media types other than print/all: a query naming only these does not reach the printer.
const NON_PRINT_MEDIA_TYPE = /\b(?:screen|speech|aural|tty|tv|projection|handheld|braille|embossed)\b/i;

/**
 * Does a media query list reach print? Each comma-separated query applies unless it names a
 * non-print media type outright (`screen`, `speech`, …) — `print`, `all`, a bare feature query
 * like `(max-width: 600px)`, and `not …`/`only print` forms all count as print-relevant; the
 * list applies when ANY query does. Conservative on purpose: a wrong "yes" only means we treat
 * a rule as the author's print intent, never that we override anything.
 */
export function mediaAppliesToPrint(query) {
  const q = String(query || "").trim();
  if (!q) return true;
  return q.split(",").some((one) => {
    const t = one.trim().toLowerCase();
    if (!t || t.startsWith("not ")) return true;
    if (/\b(?:print|all)\b/.test(t)) return true;
    return !NON_PRINT_MEDIA_TYPE.test(t);
  });
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const CSS_STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const GROUPING_AT_RULE = /^@(?:supports|layer|container|scope|document)\b/i;

/**
 * The part of a stylesheet that can reach the printer, with comments stripped and string
 * literals blanked — the text `@page`/break detection is allowed to look at. A brace-depth walk
 * (the same technique as collectGradientClipSelectors):
 *  - a plain rule is kept whole (its declarations carry the author's `break-*` rules);
 *  - `@media <q> { … }` is kept (recursively) only when `<q>` reaches print, so an `@page`
 *    inside `@media screen` is invisible, one inside `@media print` counts;
 *  - grouping at-rules (`@supports`, `@layer`, …) are walked into;
 *  - `@page` at-rules are kept whole; every other at-rule (`@font-face`, `@keyframes`, `@import`)
 *    is dropped with its block.
 * A `@page` in a CSS comment or a string is therefore never a declaration (F-050 review M1).
 */
export function printScopedCss(cssText) {
  const css = String(cssText || "").replace(CSS_COMMENT, "").replace(CSS_STRING, '""');
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const open = css.indexOf("{", i);
    if (open === -1) break;                       // trailing statement at-rules (@import …) carry nothing we read
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    const bodyStart = j;
    while (j < n && depth > 0) {
      const ch = css[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    const body = css.slice(bodyStart, j - 1);
    if (/^@media\b/i.test(prelude)) {
      if (mediaAppliesToPrint(prelude.slice(6))) out += `\n${printScopedCss(body)}`;
    } else if (GROUPING_AT_RULE.test(prelude)) {
      out += `\n${printScopedCss(body)}`;
    } else if (prelude.startsWith("@")) {
      if (AUTHOR_AT_PAGE.test(prelude)) out += `\n${css.slice(i, j)}`;
    } else {
      out += `\n${css.slice(i, j)}`;
    }
    i = j;
  }
  return out;
}

// Every <style> block's raw text (the deck contract's gradient scan reads all of it).
function styleText($) {
  return $("style").map((_, el) => $(el).html() || "").get().join("\n");
}
// The print-relevant CSS of the document: `<style media="screen">` blocks are skipped, the rest
// is reduced to what reaches the printer (printScopedCss).
function printStyleText($) {
  return $("style")
    .filter((_, el) => mediaAppliesToPrint($(el).attr("media")))
    .map((_, el) => printScopedCss($(el).html() || "")).get().join("\n");
}
function inlineStyleText($) {
  return $("[style]").map((_, el) => ($(el).attr("style") || "").replace(CSS_COMMENT, "")).get().join(";\n");
}
// "A4" → "A4 portrait": a named size with no orientation is portrait, so the declared label
// matches the one measured from the PDF (describePageSize) for the same document.
const NAMED_SIZE_WORDS = { a3: "A3", a4: "A4", a5: "A5", b4: "B4", b5: "B5", letter: "Letter", legal: "Legal", ledger: "Ledger", "jis-b4": "JIS-B4", "jis-b5": "JIS-B5" };
function normalizeDeclaredSize(raw) {
  const v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  const named = NAMED_SIZE_WORDS[v.toLowerCase()];
  return named ? `${named} portrait` : v;
}
// Depth of an element below <body> (body's children are depth 0). A slide deck is document-level
// structure: its slides sit at the top of the body (or inside ONE wrapper). A `.slide` three
// levels deep is a carousel inside a page, not a deck.
function depthBelowBody($, el) {
  let d = 0;
  let p = $(el).parent();
  while (p.length && !p.is("body") && !p.is("html")) { d++; p = p.parent(); }
  return d;
}

// The top-level (non-nested) containers matching `selector` — the unit of "one slide per page".
// A marker inside another marker is layout, not a slide, so it's excluded.
function topLevel($, selector) {
  return $(selector).filter((_, el) => $(el).parents(selector).length === 0);
}

/**
 * Decide how an export is laid out on paper. Returns
 *   { layout: "document"|"deck", source, page_size, author_geometry, slides }
 * where `source` says which rule decided, `page_size` is the declared size (author `@page`
 * for a document, the 16:9 deck size for a deck, null when the author left it to the
 * browser), `author_geometry` records what the author declared, and `slides` is the cheerio
 * selection of top-level slide containers to paginate (empty unless deck).
 *
 * PRECEDENCE (each rule is an author decision the exporter must not override):
 *  1. The doc's RECORDED style is a document (web / doc / brochure) → document.
 *  2. An EXPLICIT deck declaration — recorded style ppt/slides, or a `data-wi-kind="deck"`
 *     marker → deck. The author declared the deck; if they also declared `@page`, the paper
 *     is theirs (no 16:9 injected) and the slides paginate one per page on it.
 *  3. The author declared `@page` (print-scoped CSS only — not a comment, a string, or
 *     `@media screen`) → document. A page size is the author's, never ours; a weak marker
 *     (`.slide`) does not outrank it.
 *  4. 2+ top-level slide markers ([data-slide] / .slide / .wi-slide) at document level
 *     (depth ≤ 1 below <body>) → deck. Plain semantic <section>s never declare a deck.
 *  5. Otherwise → document (the default; the author's flow prints as it is).
 *
 * @param {string|import("cheerio").CheerioAPI} htmlOrCheerio
 * @param {{ style?: string|null }} [opts] the doc's recorded style (POST /api/docs `style`)
 */
export function classifyLayout(htmlOrCheerio, { style = null } = {}) {
  const $ = typeof htmlOrCheerio === "string" ? cheerio.load(htmlOrCheerio) : htmlOrCheerio;
  const css = printStyleText($);
  const atPage = AUTHOR_AT_PAGE.test(css);
  const pageBreaks = AUTHOR_PAGE_BREAK.test(css) || AUTHOR_PAGE_BREAK.test(inlineStyleText($));
  // Page wrappers are document-level structure too: a `.page` badge inside a slide is not one.
  const pageWrappers = topLevel($, PAGE_WRAPPER_SELECTOR).filter((_, el) => depthBelowBody($, el) <= 1).length > 0;
  const declaredSize = atPage ? normalizeDeclaredSize(AT_PAGE_SIZE.exec(css)?.[1]) : null;
  const author_geometry = { at_page: atPage, page_breaks: pageBreaks, page_wrappers: pageWrappers, page_size: declaredSize };
  const recorded = typeof style === "string" ? style.toLowerCase() : null;
  const doc = (source) => ({ layout: "document", source, page_size: declaredSize, author_geometry, slides: $([]) });
  const deck = (source) => {
    // Slides to paginate: the declared markers when present, else (style/kind-declared deck
    // with plain markup) the top-level <section>s — the ppt format's "one <section> = one slide".
    const allMarkers = topLevel($, SLIDE_MARKER_SELECTOR);
    const slides = allMarkers.length ? allMarkers : topLevel($, "section");
    // The paper is the author's when they declared it; the 16:9 deck page otherwise.
    return { layout: "deck", source, page_size: declaredSize ?? DECK_PAGE_SIZE, author_geometry, slides };
  };

  // 1. Recorded document style.
  if (recorded && DOCUMENT_STYLES.has(recorded)) return doc(LAYOUT_SOURCES.documentStyle(recorded));
  // 2. EXPLICIT deck declaration — the author declared the deck (and, if present, its paper).
  if (recorded && DECK_STYLES.has(recorded)) return deck(LAYOUT_SOURCES.deckStyle(recorded));
  if ($(DECK_KIND_SELECTOR).length > 0) return deck(LAYOUT_SOURCES.deckKind);
  // 3. Author-declared page size, no explicit deck: a page size is the author's.
  if (atPage) return doc(LAYOUT_SOURCES.authorAtPage);
  // 4. Slide markers at document level.
  const markers = topLevel($, SLIDE_MARKER_SELECTOR).filter((_, el) => depthBelowBody($, el) <= 1);
  if (markers.length >= 2) return deck(LAYOUT_SOURCES.declaredSlides(markers.length));
  // 5. Default: a document in its own flow.
  return doc(pageWrappers || pageBreaks ? LAYOUT_SOURCES.authorPageBreaks : LAYOUT_SOURCES.none);
}

/** True when the export lays out as a slide deck. Accepts an HTML string or a loaded cheerio. */
export function isDeck(htmlOrCheerio, opts = {}) {
  return classifyLayout(htmlOrCheerio, opts).layout === "deck";
}

// A declaration block clips a gradient to its glyphs when it sets
// `-webkit-background-clip:text`, `background-clip:text`, or
// `-webkit-text-fill-color:transparent`. In the deck print contract that run is painted
// solid (gotcha #3). Tolerate whitespace and casing.
const GRADIENT_CLIP_DECL = /(?:-webkit-)?background-clip\s*:\s*text|(?:-webkit-)?text-fill-color\s*:\s*transparent/i;

/**
 * Collect the SELECTORS of CSS rules whose declaration block clips a gradient to
 * its text (so the deck contract can neutralize class/<style>-defined gradient headings,
 * not just inline-styled ones). Scans the combined CSS at the TOP LEVEL only via a
 * brace-depth walk: a plain `selector { ... }` rule is inspected; an at-rule with a
 * block (`@media`, `@keyframes`, `@supports`, ...) is skipped wholesale. This keeps
 * the scan simple and well-bounded — gradient-clipped text nested inside a media
 * query is an ACCEPTABLE MISS (the inline-attribute baseline still covers inline
 * styles; class rules inside @media are rare for static headings).
 *
 * @param {string} cssText combined text of all <style> blocks
 * @returns {string[]} selectors (raw, comma-grouped selectors kept verbatim), de-duped
 */
export function collectGradientClipSelectors(cssText) {
  if (!cssText) return [];
  const selectors = [];
  let i = 0;
  const n = cssText.length;
  while (i < n) {
    // Find the next rule boundary: either `{` (start of a block) or end of text.
    const open = cssText.indexOf("{", i);
    if (open === -1) break;
    const prelude = cssText.slice(i, open).trim();

    // Walk to the matching close brace, tracking nesting so at-rules with nested
    // blocks (@media/@keyframes/@supports) consume their whole body.
    let depth = 1;
    let j = open + 1;
    const bodyStart = j;
    while (j < n && depth > 0) {
      const ch = cssText[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    const body = cssText.slice(bodyStart, j - 1);

    if (prelude.startsWith("@")) {
      // At-rule: skip its block wholesale (nested gradient text not covered — by design).
      i = j;
      continue;
    }
    // Plain style rule: a declaration-only body (no nested braces) clipping a gradient.
    if (prelude && !body.includes("{") && GRADIENT_CLIP_DECL.test(body)) {
      selectors.push(prelude);
    }
    i = j;
  }
  return [...new Set(selectors)];
}

// (A) Document head: charset + viewport — guards against mojibake on — › © ×. Additive only.
function ensureDocumentHead($) {
  if ($("head").length === 0) $("html").prepend("<head></head>");
  const $head = $("head").first();
  if ($head.find("meta[charset]").length === 0) $head.prepend('<meta charset="utf-8">');
  if ($head.find('meta[name="viewport"]').length === 0) {
    $head.find("meta[charset]").first().after('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  return $head;
}

/**
 * The HTML DELIVERABLE: the author's document plus a proper head (doctype, charset, viewport).
 * NO print injection — a customer who prints this file from any browser gets the author's own
 * `@page` / page breaks / look, exactly as if they printed the served canvas (F-050 rule 3).
 * cheerio doesn't emit a doctype, so we prepend `<!DOCTYPE html>` to the result.
 */
export function finalizeHtml(html) {
  const $ = cheerio.load(html);
  ensureDocumentHead($);
  return `<!DOCTYPE html>\n${$.html()}`;
}

/**
 * The PDF-PREP copy: `finalizeHtml` plus the print rules the headless render needs, scoped by
 * layout. A document gets the render-safety baseline only (its geometry is untouched); a
 * DECLARED deck gets the deck baseline, the 16:9 `@page`, and one-slide-per-page geometry —
 * each only where the author has not declared that piece themselves.
 * Returns the decorated HTML string; pass `withLayout: true` to get `{ html, layout }`.
 *
 * @param {string} html self-contained HTML (assets already inlined)
 * @param {{ style?: string|null, withLayout?: boolean }} [opts]
 */
export function decorateForExport(html, { style = null, withLayout = false } = {}) {
  const $ = cheerio.load(html);
  const $head = ensureDocumentHead($);
  const layout = classifyLayout($, { style });

  const parts = [PRINT_RENDER_SAFETY_CSS];
  if (layout.layout === "deck") {
    parts.push(PRINT_DECK_BASELINE_CSS);
    // Page size: ours only when the author declared none. An EXPLICIT deck (style ppt /
    // data-wi-kind) with its own `@page` keeps that paper and gets the slide pagination below.
    if (!layout.author_geometry.at_page) parts.push(PRINT_DECK_PAGE_CSS);
    // One slide per page: ours only when the author declared no page breaks / page wrappers.
    // Stamp `wi-slide-top` onto ONLY the top-level slides so the 100vh/overflow rules never hit
    // nested ones.
    if (!layout.author_geometry.page_breaks && !layout.author_geometry.page_wrappers && layout.slides.length) {
      layout.slides.addClass("wi-slide-top");
      parts.push(PRINT_DECK_SLIDES_CSS);
    }
    // Class/<style>-aware gradient-text neutralization (deck contract, gotcha #3). By this
    // point inlineHtml has already turned <link> stylesheets into <style> blocks, so all that
    // CSS text lives in the document — scan it, collect the clipping rules' selectors, and
    // append a print override targeting them (alongside the inline-attribute selectors).
    const clipSelectors = collectGradientClipSelectors(styleText($));
    if (clipSelectors.length) {
      parts.push([
        "@media print {",
        `  ${clipSelectors.join(", ")} {`,
        "    background: none !important; -webkit-text-fill-color: currentColor !important;",
        "    color: inherit !important;",
        "  }",
        "}",
      ].join("\n"));
    }
  }

  $head.append(`<style media="print" data-wi-print data-wi-layout="${layout.layout}">\n${parts.join("\n")}\n</style>`);
  const out = `<!DOCTYPE html>\n${$.html()}`;
  return withLayout ? { html: out, layout } : out;
}

// Rewrite url(local) inside CSS to data-URIs, resolved relative to the CSS file's dir.
function inlineCssUrls(css, cssDir) {
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, url) => {
    if (!isLocal(url)) return m;
    const abs = resolve(cssDir, url);
    return existsSync(abs) ? `url(${dataUri(abs)})` : m;
  });
}

/**
 * Produce a self-contained version of `html`. Local assets are resolved against `baseDir`.
 * @returns {string}
 */
export function inlineHtml(html, { baseDir }) {
  const $ = cheerio.load(html);

  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!isLocal(href)) return;
    const abs = resolve(baseDir, href);
    if (!existsSync(abs)) return;
    const css = inlineCssUrls(readFileSync(abs, "utf-8"), dirname(abs));
    // Keep the link's media scope: a screen-only stylesheet must stay screen-only once inlined.
    const media = $(el).attr("media");
    $(el).replaceWith(media ? `<style media="${media.replace(/"/g, "&quot;")}">${css}</style>` : `<style>${css}</style>`);
  });

  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!isLocal(src)) return;
    const abs = resolve(baseDir, src);
    if (!existsSync(abs)) return;
    $(el).removeAttr("src").text(readFileSync(abs, "utf-8"));
  });

  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!isLocal(src)) return;
    const abs = resolve(baseDir, src);
    if (existsSync(abs)) $(el).attr("src", dataUri(abs));
  });

  // Inline any remaining <style> blocks' url() refs (baseDir-relative).
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css && css.includes("url(")) $(el).text(inlineCssUrls(css, baseDir));
  });

  return $.html();
}

// ---------------------------------------------------------------------------
// PDF inspection — what the export actually produced (F-050 rule 4).
// ---------------------------------------------------------------------------

const PT_PER_IN = 72;
const PT_PER_MM = 72 / 25.4;
// Named sizes in points, portrait orientation. Matched within ±2pt (Chrome rounds A-series to 0.01mm).
const NAMED_SIZES = [
  ["A4", 210 * PT_PER_MM, 297 * PT_PER_MM],
  ["A3", 297 * PT_PER_MM, 420 * PT_PER_MM],
  ["A5", 148 * PT_PER_MM, 210 * PT_PER_MM],
  ["Letter", 8.5 * PT_PER_IN, 11 * PT_PER_IN],
  ["Legal", 8.5 * PT_PER_IN, 14 * PT_PER_IN],
];

/** Human label for a page box in points: "A4 portrait", "Letter landscape", "16:9 (960 × 540 pt)", or "W × H pt". */
export function describePageSize(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const near = (a, b) => Math.abs(a - b) <= 2;
  for (const [name, w, h] of NAMED_SIZES) {
    if (near(width, w) && near(height, h)) return `${name} portrait`;
    if (near(width, h) && near(height, w)) return `${name} landscape`;
  }
  const r = (n) => Math.round(n * 100) / 100;
  if (Math.abs(width / height - 16 / 9) < 0.005) return `16:9 (${r(width)} × ${r(height)} pt)`;
  return `${r(width)} × ${r(height)} pt`;
}

/**
 * Read page count + first-page size out of a rendered PDF. Chrome/Skia writes PDF 1.4 with
 * plain (uncompressed) page objects, so a lexical scan is enough: the root `/Type /Pages`
 * node's `/Count` is the page count (fallback: count `/Type /Page` objects), and the first
 * `/MediaBox` is the page box. Returns `{ pages, page_size_pt: {width,height}, page_size }`
 * with nulls for anything the file did not expose (e.g. compressed object streams) — never throws.
 */
export function inspectPdf(pdfPath) {
  let text;
  try { text = readFileSync(pdfPath).toString("latin1"); } catch { return { pages: null, page_size_pt: null, page_size: null }; }
  let pages = null;
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length) pages = Math.max(...counts);
  else {
    const leaves = text.match(/\/Type\s*\/Page(?![s\w])/g);
    if (leaves) pages = leaves.length;
  }
  let page_size_pt = null;
  const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
  if (box) {
    const [x0, y0, x1, y1] = box.slice(1, 5).map(Number);
    const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
    if (width > 0 && height > 0) page_size_pt = { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
  }
  return { pages, page_size_pt, page_size: page_size_pt ? describePageSize(page_size_pt.width, page_size_pt.height) : null };
}

/** Friendly download base — names exports after the doc + version: "<doc-slug>_v<version>"
 *  (e.g. agent-harness_v17.pdf) instead of a generic export_v17.*. The doc slug is the doc
 *  directory's basename (already slug-safe); we still sanitize defensively to the
 *  Content-Disposition / download-route charset so the saved filename is always valid. */
export function downloadBase(dir, version) {
  const slug = (basename(dir) || "document").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
  return `${slug}_v${version}`;
}

function exportsDir(dir) {
  const out = join(dir, "exports");
  mkdirSync(out, { recursive: true });
  return out;
}

/** The doc's recorded style (POST /api/docs `style`, persisted on the manifest), or null. */
function recordedStyle(dir) {
  try { return loadManifest(dir).style ?? null; } catch { return null; }
}

/** The additive "what did the export do" fields shared by every format (F-050 rule 4). */
function layoutReport(layout) {
  return { layout: layout.layout, layout_source: layout.source, page_size: layout.page_size ?? null };
}

/**
 * Export version → self-contained HTML (the deliverable). The author's document as authored,
 * plus a document head; no print injection (see finalizeHtml).
 * @returns {{ path: string, bytes: number, layout: string, layout_source: string, page_size: string|null, pages: null }}
 */
export function exportHtml(dir, version, outPath) {
  const inlined = inlineHtml(readVersionHtml(dir, version), { baseDir: dir });
  const html = finalizeHtml(inlined);
  const path = outPath || join(exportsDir(dir), `${downloadBase(dir, version)}.html`);
  writeFileSync(path, html);
  // Report the layout the PDF export WOULD use, so the UI can say "document · A4 portrait" up front.
  const layout = classifyLayout(inlined, { style: recordedStyle(dir) });
  return { path, bytes: Buffer.byteLength(html), ...layoutReport(layout), pages: null };
}

/** Locate a Chrome/Chromium binary (env override wins). */
export function findChrome(override) {
  const candidates = [
    override, process.env.WI_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || null;
}

/**
 * Default PDF renderer: ASYNC headless Chrome --print-to-pdf over the self-contained HTML.
 * Uses `spawn` (not spawnSync) so a multi-second render never blocks the Node event loop /
 * SSE heartbeats (issue #18) — mirrors theme-grab.js's chromeUrlRenderer.
 *
 * Page sizing is driven by CSS `@page` — the author's for a document, the deck contract's for
 * a declared deck (issue #12, F-050) — new headless honors CSS `@page size` for
 * `--print-to-pdf` automatically, so the flags stay minimal and backward-compatible.
 * Backgrounds survive via the injected `print-color-adjust:exact` (CSS), not a CLI flag: new
 * headless has no `--print-background` switch, so we deliberately drive that from the @media
 * print baseline instead. The opts are accepted so a caller can tune behavior, but the
 * defaults reproduce the prior command exactly:
 *  - `noHeaderFooter` (default true): suppress Chrome's date/url header & footer.
 *  - extra `args`: appended verbatim for forward compatibility (e.g. custom flags).
 * Existing callers pass only `{ chromePath }`; the signature/defaults are unchanged.
 * @returns {Promise<void>}
 */
export function chromeRenderer(htmlPath, pdfPath, opts = {}) {
  const { chromePath, noHeaderFooter = true, args = [] } = opts;
  const chrome = findChrome(chromePath);
  if (!chrome) throw new Error("no Chrome/Chromium found for PDF render (set WI_CHROME)");
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox"];
  if (noHeaderFooter) flags.push("--no-pdf-header-footer");
  flags.push(...args, `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`);
  return new Promise((resolveP, reject) => {
    // ignore stdout (unread + full → deadlock); pipe stderr only; guard the stderr stream.
    const child = spawn(chrome, flags, { timeout: 60000, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d; });
    child.stderr?.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0 || !existsSync(pdfPath)) {
        reject(new Error(`chrome PDF render failed (${signal ? `signal ${signal}` : `status ${code}`}): ${stderr.slice(0, 300)}`));
      } else {
        resolveP();
      }
    });
  });
}

/**
 * Export version → PDF. Builds the PDF-prep HTML (`export_v<N>.pdf.html`: inlined + print
 * rules scoped by layout), renders it, then inspects the result so the caller can report what
 * was produced. `renderer(htmlPath, pdfPath, opts)` is injectable (tests pass a fake). Async —
 * awaits the render so it never blocks the loop (issue #18); `await` tolerates a sync fake's return.
 * @returns {Promise<{ path: string, layout: string, layout_source: string, page_size: string|null,
 *                     page_size_pt: {width:number,height:number}|null, pages: number|null }>}
 */
export async function exportPdf(dir, version, outPath, { renderer = chromeRenderer, chromePath, renderOpts = {} } = {}) {
  const inlined = inlineHtml(readVersionHtml(dir, version), { baseDir: dir });
  const { html, layout } = decorateForExport(inlined, { style: recordedStyle(dir), withLayout: true });
  const htmlPath = join(exportsDir(dir), `export_v${version}.pdf.html`);
  writeFileSync(htmlPath, html);
  const path = outPath || join(exportsDir(dir), `${downloadBase(dir, version)}.pdf`);
  await renderer(htmlPath, path, { chromePath, ...renderOpts });
  // What the render ACTUALLY produced wins over what was declared (a fake renderer yields nulls).
  const produced = inspectPdf(path);
  return {
    path,
    ...layoutReport(layout),
    page_size: produced.page_size ?? layout.page_size ?? null,
    page_size_pt: produced.page_size_pt,
    pages: produced.pages,
  };
}
