// export.js — export a version to a self-contained interactive HTML or a PDF (ADR-0009).
//
// HTML: inline local stylesheets, scripts, images (data-URI), and url() refs inside inlined
//       CSS, so the file renders + stays interactive opened straight from disk (no server).
// PDF:  render the self-contained HTML via headless Chrome (the same primitive the absorbed
//       prezzie export pipeline used — ADR-0020).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import * as cheerio from "cheerio";
import { readVersionHtml } from "./fsstore.js";

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
// Print contract (issue #12). `chrome --print-to-pdf` (new headless) renders
// with NO @page size, NO print-background, and FIRES @media (max-width) rules
// because it lays the page out narrow. Five gotchas + a missing <head> make a
// straight export look broken in PDF. We fix BOTH the HTML export and the PDF
// render in ONE place by injecting this into the self-contained <head>; the PDF
// path renders that same HTML, so the @page CSS drives page size (new headless
// honors CSS @page automatically) and the renderer flags stay minimal.
// ---------------------------------------------------------------------------

// UNIVERSALLY SAFE — injected for EVERY export (deck or plain doc), zero downside:
//  - kill box-shadow/text-shadow (gotcha #4: glows print as hard rectangles)
//  - print-color-adjust:exact (the GOOD one: keeps dark bg + real gradient FILLS)
//  - neutralize gradient-clipped text (gotcha #3: -webkit-background-clip:text +
//    transparent fill paints the whole box in --print-to-pdf). We override the
//    clipped run back to a solid: drop the gradient, fill with currentColor, and
//    fall back the text color to inherit so headings/numbers/em-runs are readable
//    instead of colored rectangles.
const PRINT_BASELINE_CSS = [
  "@media print {",
  "  * { box-shadow: none !important; text-shadow: none !important; }",
  "  * { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }",
  // COMPLETED-STATE (issue: blank/partial PDFs). Decks animate content in on the SCREEN —
  // scroll-reveals and step-builds hide elements with opacity/visibility/transform until
  // shown, and looping animations spin forever. In PRINT there is no scroll and no
  // keyframe clock, so that content renders INVISIBLE or frozen mid-spin. Force every
  // animation/transition off (settle to its base) and force the common reveal/step
  // patterns to their COMPLETED, visible state so the whole deck prints as authored.
  // This is universally safe: a static doc has nothing matching these selectors.
  "  *, *::before, *::after { animation: none !important; transition: none !important; }",
  "  [data-step], [data-reveal], [data-animate], [data-anim], [data-aos],",
  "  [class*=\"reveal\"], [class*=\"animate\"], [class*=\"fade\"], [class*=\"-rv\"],",
  "  [class*=\"slide-in\"], [class*=\"build\"], .is-hidden, .is-out {",
  "    opacity: 1 !important; visibility: visible !important; transform: none !important;",
  "  }",
  // Any run that clipped a gradient to its glyphs: paint it solid instead.
  "  [style*=\"-webkit-background-clip\"], [style*=\"background-clip\"],",
  "  [style*=\"text-fill-color\"] {",
  "    background: none !important; -webkit-background-clip: border-box !important;",
  "    background-clip: border-box !important; -webkit-text-fill-color: currentColor !important;",
  "    color: inherit !important;",
  "  }",
  "}",
].join("\n");

// DECK-SPECIFIC — CONDITIONAL, only when the doc is detected as a deck. A tall
// single-column article would be HARMED by a forced 16:9 landscape page, so we
// must NEVER inject this blanket. 13.333in x 7.5in == 960x540pt == 16:9.
// We target `.wi-slide-top`, a class decorateForExport stamps onto ONLY the
// top-level slide containers — a NESTED <section>/.slide (a sub-layout, tabs, or
// an inner card) must NOT be forced to 100vh/overflow:hidden or its content would
// clip. The geometry declarations carry !important so an author class rule can't
// silently override one-slide-per-page. (@page declarations don't take !important.)
const PRINT_DECK_CSS = [
  "@media print {",
  "  @page { size: 13.333in 7.5in; margin: 0; }",        // gotcha #1: portrait Letter default
  "  html, body { margin: 0; padding: 0; }",
  // gotcha #5: one slide per page, no continuous-scroll whitespace.
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

const SLIDE_SELECTOR = "section, [data-slide], .slide";

// The top-level (non-nested) slide containers — the unit of "one slide per page".
// A <section> inside a slide is layout, not a slide, so it's excluded.
function topLevelSlides($) {
  return $(SLIDE_SELECTOR).filter((_, el) => $(el).parents(SLIDE_SELECTOR).length === 0);
}

// A declaration block clips a gradient to its glyphs when it sets
// `-webkit-background-clip:text`, `background-clip:text`, or
// `-webkit-text-fill-color:transparent`. In --print-to-pdf that paints the
// whole element box instead of the text, so the run prints as a colored
// rectangle (gotcha #3). Tolerate whitespace and casing.
const GRADIENT_CLIP_DECL = /(?:-webkit-)?background-clip\s*:\s*text|(?:-webkit-)?text-fill-color\s*:\s*transparent/i;

/**
 * Collect the SELECTORS of CSS rules whose declaration block clips a gradient to
 * its text (so we can neutralize class/<style>-defined gradient headings in print,
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

/**
 * Detect whether an export is a slide DECK (vs a continuous-scroll doc / article).
 *
 * DETECTION CHOICE (narrowest safe trigger): a doc is a deck only when it carries
 * 2+ top-level slide containers (`section`, `[data-slide]`, `.slide`). This matches
 * how the tool authors decks — "one slide per `<section>`", "~6-18 slides"
 * (skills/assist/references/outline-method.md) — while staying off plain docs:
 * a one-pager/landing page legitimately uses a single `<section>` wrapper, and a
 * long article uses none. Either of those gets the universally-safe baseline only,
 * never the forced 16:9 landscape @page that would break a tall scrolling doc.
 * We count only NON-NESTED containers so a stray inner `<section>` doesn't flip a
 * single-section one-pager into "deck".
 */
// Accepts an HTML string OR an already-loaded cheerio instance, so decorateForExport
// can reuse its `$` instead of parsing the document a second time.
export function isDeck(htmlOrCheerio) {
  const $ = typeof htmlOrCheerio === "string" ? cheerio.load(htmlOrCheerio) : htmlOrCheerio;
  return topLevelSlides($).length >= 2;
}

/**
 * Add the export-only document head + print stylesheet to a self-contained HTML
 * string. Universally-safe baseline always; deck @page rules only for decks.
 * cheerio doesn't emit a doctype, so we prepend `<!DOCTYPE html>` to the result.
 */
export function decorateForExport(html) {
  const $ = cheerio.load(html);

  // (A) Document head: charset + viewport — guards against mojibake on — › © ×.
  if ($("head").length === 0) $("html").prepend("<head></head>");
  const $head = $("head").first();
  if ($head.find('meta[charset]').length === 0) $head.prepend('<meta charset="utf-8">');
  if ($head.find('meta[name="viewport"]').length === 0) {
    $head.find('meta[charset]').first().after('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }

  // (B) Print stylesheet: baseline always; deck rules only when detected as a deck.
  // Reuse the loaded `$` (no second parse). For a deck, stamp `wi-slide-top` onto ONLY
  // the top-level slides so PRINT_DECK_CSS's 100vh/overflow rules never hit nested ones.
  const deck = isDeck($);
  if (deck) topLevelSlides($).addClass("wi-slide-top");
  let css = deck ? `${PRINT_BASELINE_CSS}\n${PRINT_DECK_CSS}` : PRINT_BASELINE_CSS;

  // (B.1) Class/<style>-aware gradient-text neutralization. The inline-attribute
  // selectors in PRINT_BASELINE_CSS only catch gradient text styled via `style="..."`.
  // A heading clipped via a CSS class or a <style> rule (e.g. `.grad{...; -webkit-
  // background-clip:text; -webkit-text-fill-color:transparent}`) would still print as
  // a colored box. By this point inlineHtml has already turned <link> stylesheets into
  // <style> blocks, so all that CSS text lives in the document — scan it, collect the
  // clipping rules' selectors, and append a print override targeting them (belt and
  // suspenders alongside the inline-attribute selectors above).
  const styleCss = $("style").map((_, el) => $(el).html() || "").get().join("\n");
  const clipSelectors = collectGradientClipSelectors(styleCss);
  if (clipSelectors.length) {
    css += [
      "\n@media print {",
      `  ${clipSelectors.join(", ")} {`,
      "    background: none !important; -webkit-text-fill-color: currentColor !important;",
      "    color: inherit !important;",
      "  }",
      "}",
    ].join("\n");
  }

  $head.append(`<style media="print" data-wi-print>\n${css}\n</style>`);

  // cheerio strips/omits the doctype — prepend it so the export is a valid document.
  return `<!DOCTYPE html>\n${$.html()}`;
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
    $(el).replaceWith(`<style>${css}</style>`);
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

/** Export version → self-contained HTML. @returns {{ path: string, bytes: number }} */
export function exportHtml(dir, version, outPath) {
  // Inline assets first, then decorate with the proper <head> + print contract
  // (issue #12). Decorating here fixes BOTH the HTML export and the PDF render,
  // since exportPdf renders this exact file.
  const html = decorateForExport(inlineHtml(readVersionHtml(dir, version), { baseDir: dir }));
  const path = outPath || join(exportsDir(dir), `${downloadBase(dir, version)}.html`);
  writeFileSync(path, html);
  return { path, bytes: Buffer.byteLength(html) };
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
 * Page sizing is driven by the `@page` CSS injected into the HTML (issue #12) —
 * new headless honors CSS `@page size` for `--print-to-pdf` automatically — so the
 * flags stay minimal and backward-compatible. Backgrounds survive via the injected
 * `print-color-adjust:exact` (CSS), not a CLI flag: new headless has no
 * `--print-background` switch, so we deliberately drive that from the @media print
 * baseline instead. The opts are accepted so a caller can tune behavior, but the
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
 * Export version → PDF. First builds the self-contained HTML, then renders it.
 * `renderer(htmlPath, pdfPath, opts)` is injectable (tests pass a fake). Async — awaits
 * the render so it never blocks the loop (issue #18); `await` tolerates a sync fake's return.
 * @returns {Promise<{ path: string }>}
 */
export async function exportPdf(dir, version, outPath, { renderer = chromeRenderer, chromePath, renderOpts = {} } = {}) {
  const { path: htmlPath } = exportHtml(dir, version, join(exportsDir(dir), `export_v${version}.pdf.html`));
  const path = outPath || join(exportsDir(dir), `${downloadBase(dir, version)}.pdf`);
  await renderer(htmlPath, path, { chromePath, ...renderOpts });
  return { path };
}
