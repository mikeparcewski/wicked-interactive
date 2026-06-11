// export.js — export a version to a self-contained interactive HTML or a PDF (ADR-0009).
//
// HTML: inline local stylesheets, scripts, images (data-URI), and url() refs inside inlined
//       CSS, so the file renders + stays interactive opened straight from disk (no server).
// PDF:  render the self-contained HTML via headless Chrome (the same primitive the absorbed
//       prezzie export pipeline used — ADR-0020).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
const PRINT_DECK_CSS = [
  "@media print {",
  "  @page { size: 13.333in 7.5in; margin: 0; }",        // gotcha #1: portrait Letter default
  "  html, body { margin: 0; padding: 0; }",
  // gotcha #5: one slide per page, no continuous-scroll whitespace.
  "  section, [data-slide], .slide {",
  "    min-height: 100vh; height: 100vh; box-sizing: border-box;",
  "    break-after: page; page-break-after: always; overflow: hidden;",
  "    display: flex; flex-direction: column; justify-content: center;",
  "  }",
  "  section:last-child, [data-slide]:last-child, .slide:last-child {",
  "    break-after: auto; page-break-after: auto;",
  "  }",
  "}",
].join("\n");

const SLIDE_SELECTOR = "section, [data-slide], .slide";

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
export function isDeck(html) {
  const $ = cheerio.load(html);
  const tops = $(SLIDE_SELECTOR).filter((_, el) => $(el).parents(SLIDE_SELECTOR).length === 0);
  return tops.length >= 2;
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
  const css = isDeck(html) ? `${PRINT_BASELINE_CSS}\n${PRINT_DECK_CSS}` : PRINT_BASELINE_CSS;
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
  const path = outPath || join(exportsDir(dir), `export_v${version}.html`);
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
 * Default PDF renderer: headless Chrome --print-to-pdf over the self-contained HTML.
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
 */
export function chromeRenderer(htmlPath, pdfPath, opts = {}) {
  const { chromePath, noHeaderFooter = true, args = [] } = opts;
  const chrome = findChrome(chromePath);
  if (!chrome) throw new Error("no Chrome/Chromium found for PDF render (set WI_CHROME)");
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox"];
  if (noHeaderFooter) flags.push("--no-pdf-header-footer");
  flags.push(...args, `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`);
  const r = spawnSync(chrome, flags, { timeout: 60000 });
  if (r.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`chrome PDF render failed (status ${r.status}): ${r.stderr?.toString().slice(0, 300)}`);
  }
}

/**
 * Export version → PDF. First builds the self-contained HTML, then renders it.
 * `renderer(htmlPath, pdfPath, opts)` is injectable (tests pass a fake).
 * @returns {{ path: string }}
 */
export function exportPdf(dir, version, outPath, { renderer = chromeRenderer, chromePath, renderOpts = {} } = {}) {
  const { path: htmlPath } = exportHtml(dir, version, join(exportsDir(dir), `export_v${version}.pdf.html`));
  const path = outPath || join(exportsDir(dir), `export_v${version}.pdf`);
  renderer(htmlPath, path, { chromePath, ...renderOpts });
  return { path };
}
