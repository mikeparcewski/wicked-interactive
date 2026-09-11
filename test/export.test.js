import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  inlineHtml, exportHtml, exportPdf, decorateForExport, finalizeHtml, isDeck, classifyLayout,
  collectGradientClipSelectors, inspectPdf, describePageSize, findChrome, chromeRenderer, DECK_PAGE_SIZE,
  printScopedCss, mediaAppliesToPrint, LAYOUT_SOURCES,
} from "../src/service/export.js";
import * as cheerio from "cheerio";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";

process.env.WICKED_NO_BUS = "1";
// The server tests below emit real bus events; keep them out of the operator's bus data dir.
process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-export-"));

// 1x1 transparent PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function assetDir() {
  const dir = mkdtempSync(join(tmpdir(), "wi-exp-"));
  writeFileSync(join(dir, "style.css"), "h1 { color: red; }");
  writeFileSync(join(dir, "app.js"), "console.log('hi');");
  writeFileSync(join(dir, "logo.png"), Buffer.from(PNG_B64, "base64"));
  return dir;
}

test("inlineHtml inlines local stylesheet, script, and image", () => {
  const dir = assetDir();
  try {
    const html = `<html><head><link rel="stylesheet" href="style.css"></head>
      <body><img src="logo.png"><script src="app.js"></script></body></html>`;
    const out = inlineHtml(html, { baseDir: dir });
    assert.match(out, /<style>h1 \{ color: red; \}<\/style>/);
    assert.match(out, /console\.log\('hi'\)/);
    assert.match(out, /src="data:image\/png;base64,/);
    assert.doesNotMatch(out, /href="style\.css"/);
    assert.doesNotMatch(out, /src="app\.js"/);
    assert.doesNotMatch(out, /src="logo\.png"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("inlineHtml leaves remote and data URLs untouched", () => {
  const html = `<img src="https://x/y.png"><img src="data:image/png;base64,AAA">`;
  const out = inlineHtml(html, { baseDir: "/nonexistent" });
  assert.match(out, /src="https:\/\/x\/y\.png"/);
  assert.match(out, /src="data:image\/png;base64,AAA"/);
});

test("exportHtml produces a self-contained file from a version", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, `<h1>Title</h1><img src="logo.png">`);
    const { path, bytes } = exportHtml(dir, 0);
    assert.ok(existsSync(path));
    assert.ok(bytes > 0);
    const out = readFileSync(path, "utf-8");
    assert.match(out, /src="data:image\/png;base64,/);
    assert.doesNotMatch(out, /src="logo\.png"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exportPdf builds the self-contained HTML and delegates to the renderer", async () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, `<h1>Title</h1>`);
    let renderedHtmlPath = null;
    const fakeRenderer = (htmlPath, pdfPath) => {
      renderedHtmlPath = htmlPath;
      assert.ok(existsSync(htmlPath), "renderer receives a real self-contained HTML file");
      writeFileSync(pdfPath, "%PDF-1.4 fake");
    };
    const { path } = await exportPdf(dir, 0, undefined, { renderer: fakeRenderer });
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf-8"), /^%PDF/);
    assert.ok(renderedHtmlPath && existsSync(renderedHtmlPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exports are named <doc-slug>_v<version>.<ext> (download name follows doc + version)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wi-exp-"));
  const dir = join(root, "my-deck");
  mkdirSync(dir, { recursive: true });
  try {
    initWorkspace(dir, `<h1>Title</h1>`);
    assert.equal(basename(exportHtml(dir, 0).path), "my-deck_v0.html");
    const { path } = await exportPdf(dir, 0, undefined, { renderer: (h, p) => writeFileSync(p, "%PDF-1.4") });
    assert.equal(basename(path), "my-deck_v0.pdf");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- issue #12 / F-050: print contract ---------------------------------------
//
// The HTML export is the author's document plus a document head — NO print injection.
// The PDF-prep copy (what headless Chrome renders) carries print rules scoped by layout:
// a document keeps the author's page geometry untouched; only a DECLARED deck gets the
// 16:9 @page + one-slide-per-page geometry. Plain semantic <section>s never declare a deck.

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
// The real brochure v3 from the acceptance program (F-050 / F-4R2-015): a two-page A4 print
// document — author `@page { size: A4 portrait }`, two `.page` wrappers, five semantic <section>s.
const BROCHURE = readFileSync(new URL("brochure-a4-two-page.html", FIXTURE_DIR), "utf-8");
const DECK = `<html><head></head><body>` +
  `<section class="wi-slide"><h1>Slide 1</h1></section>` +
  `<section class="wi-slide"><h2>Slide 2</h2></section>` +
  `<section class="wi-slide"><h2>Slide 3</h2></section></body></html>`;

test("exported HTML carries a proper document head (doctype, charset, viewport)", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, `<h1>Title</h1>`);
    const { path } = exportHtml(dir, 0);
    const out = readFileSync(path, "utf-8");
    assert.match(out, /^<!DOCTYPE html>/);
    assert.match(out, /<meta charset="utf-8">/);
    assert.match(out, /<meta name="viewport"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-050 (3): the HTML export carries NO print injection — the author's print CSS ships untouched", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, BROCHURE);
    const { path, layout, page_size, pages } = exportHtml(dir, 0);
    const out = readFileSync(path, "utf-8");
    assert.doesNotMatch(out, /data-wi-print/);
    assert.doesNotMatch(out, /wi-slide-top/);
    assert.doesNotMatch(out, /13\.333in/);
    assert.doesNotMatch(out, /print-color-adjust:\s*exact\s*!important/);  // not even the baseline
    assert.match(out, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*0;\s*\}/);  // the author's rule, verbatim
    // The export reports what the PDF WOULD do, up front.
    assert.equal(layout, "document");
    assert.equal(page_size, "A4 portrait");
    assert.equal(pages, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-050 (3): the HTML export equals the stored version apart from the allowed head additions", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, BROCHURE);
    const stored = readFileSync(join(dir, "_v0.html"), "utf-8");
    const out = readFileSync(exportHtml(dir, 0).path, "utf-8");
    const $src = cheerio.load(stored), $out = cheerio.load(out);
    // Allowed additions: doctype + charset/viewport metas. Everything else is byte-equal at
    // the serialization level — same head styles/title, same body markup.
    $out('meta[name="viewport"]').remove();
    $out("meta[charset]").remove();
    $src("meta[charset]").remove();
    assert.equal($out("head").html().trim(), $src("head").html().trim());
    assert.equal($out("body").html(), $src("body").html());
    assert.equal($out("style").length, $src("style").length);
    assert.equal($out("[data-wid]").length, $src("[data-wid]").length);  // INV-2 anchors intact
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PDF-prep copy of a DOCUMENT gets the render-safety baseline only — no geometry, no look changes", () => {
  const { html, layout } = decorateForExport(
    `<html><head></head><body><article><h1>Article</h1>${"<p class=\"reveal\">para</p>".repeat(40)}</article></body></html>`,
    { withLayout: true },
  );
  assert.equal(layout.layout, "document");
  assert.match(html, /<style media="print" data-wi-print="" data-wi-layout="document">/);
  // render-safety: completed state + color-adjust
  assert.match(html, /animation:\s*none\s*!important/);
  assert.match(html, /opacity:\s*1\s*!important/);
  assert.match(html, /print-color-adjust:\s*exact/);
  // NEVER for a document: page size, slide geometry, shadow stripping, gradient flattening
  assert.doesNotMatch(html, /@page/);
  assert.doesNotMatch(html, /break-after:\s*page/);
  assert.doesNotMatch(html, /wi-slide-top/);
  assert.doesNotMatch(html, /box-shadow:\s*none/);
  assert.doesNotMatch(html, /-webkit-text-fill-color:\s*currentColor/);
});

test("F-050 (1): an author-declared @page is never overridden — 5 plain <section>s stay a document", () => {
  const { html, layout } = decorateForExport(BROCHURE, { withLayout: true });
  assert.equal(layout.layout, "document");
  assert.equal(layout.source, "author @page");
  assert.equal(layout.page_size, "A4 portrait");
  assert.deepEqual(layout.author_geometry, { at_page: true, page_breaks: true, page_wrappers: true, page_size: "A4 portrait" });
  assert.doesNotMatch(html, /13\.333in/);
  assert.doesNotMatch(html, /wi-slide-top/);
  assert.match(html, /@page\s*\{\s*size:\s*A4 portrait/);
  // an @page beats even deck markers: the author's size is the author's
  const marked = classifyLayout(`<style>@page { size: Letter landscape }</style><div class="slide">1</div><div class="slide">2</div>`);
  assert.equal(marked.layout, "document");
  assert.equal(marked.page_size, "Letter landscape");
  // a bare named size is reported as portrait, matching the label measured from the PDF
  assert.equal(classifyLayout(`<style>@page { size: A4 }</style><p>x</p>`).page_size, "A4 portrait");
});

test("M1: `@page` counts only where the author DECLARED it — not in a comment, a string, or non-print media", () => {
  const deck = `<div class="slide">1</div><div class="slide">2</div><div class="slide">3</div>`;
  // a CSS comment mentioning @page is not a declaration
  const commented = classifyLayout(`<style>/* we do not set @page here */ .slide { height: 100vh }</style>${deck}`);
  assert.equal(commented.layout, "deck");
  assert.equal(commented.author_geometry.at_page, false);
  // a string literal is not a declaration
  assert.equal(classifyLayout(`<style>.slide::after { content: "@page" }</style>${deck}`).layout, "deck");
  // @page-foo is not @page
  assert.equal(classifyLayout(`<style>@page-foo { size: A4 }</style>${deck}`).layout, "deck");
  // @page inside @media screen never reaches the printer
  assert.equal(classifyLayout(`<style>@media screen { @page { size: A4 } }</style>${deck}`).layout, "deck");
  // ...nor does a <style media="screen"> block
  assert.equal(classifyLayout(`<style media="screen">@page { size: A4 }</style>${deck}`).layout, "deck");
  // @page inside @media print DOES count, and its size is read
  const printed = classifyLayout(`<style>@media print { @page { size: A4 landscape } }</style>${deck}`);
  assert.equal(printed.layout, "document");
  assert.equal(printed.source, LAYOUT_SOURCES.authorAtPage);
  assert.equal(printed.page_size, "A4 landscape");
  // a bare feature query applies to all media types, print included
  assert.equal(classifyLayout(`<style>@media (max-width: 600px) { @page { size: A5 } }</style>${deck}`).layout, "document");
  // <style media="print"> and media="all" count
  assert.equal(classifyLayout(`<style media="print">@page { size: A4 }</style>${deck}`).layout, "document");
  // page-break rules follow the same scoping: commented / screen-only breaks are not author breaks
  assert.equal(classifyLayout(`<style>/* break-after: page */ .x{}</style><p>x</p>`).author_geometry.page_breaks, false);
  assert.equal(classifyLayout(`<style>@media screen { .x { break-after: page } }</style><p>x</p>`).author_geometry.page_breaks, false);
  assert.equal(classifyLayout(`<style>.x { break-after: page }</style><p>x</p>`).author_geometry.page_breaks, true);
});

test("M1: printScopedCss / mediaAppliesToPrint", () => {
  const scoped = printScopedCss(`/* @page */ .a { break-after: page } @media screen { @page { size: A4 } }
    @media print and (orientation: landscape) { @page { size: A4 landscape } } @supports (display: grid) { .b { break-before: page } }
    @font-face { src: url(x) } @keyframes k { from { opacity: 0 } } .c::after { content: "@page {}" }`);
  assert.match(scoped, /\.a \{ break-after: page \}/);
  assert.match(scoped, /@page \{ size: A4 landscape \}/);
  assert.doesNotMatch(scoped, /size: A4 \}/);           // the screen-only @page is gone
  assert.match(scoped, /\.b \{ break-before: page \}/); // grouping at-rules are walked into
  assert.doesNotMatch(scoped, /font-face|keyframes|opacity/);
  assert.doesNotMatch(scoped, /content: "@page/);        // strings are blanked
  assert.equal(mediaAppliesToPrint(""), true);
  assert.equal(mediaAppliesToPrint("print"), true);
  assert.equal(mediaAppliesToPrint("all"), true);
  assert.equal(mediaAppliesToPrint("screen"), false);
  assert.equal(mediaAppliesToPrint("screen, print"), true);
  assert.equal(mediaAppliesToPrint("only screen and (max-width: 600px)"), false);
  assert.equal(mediaAppliesToPrint("(max-width: 600px)"), true);
  assert.equal(mediaAppliesToPrint("not screen"), true);
});

test("inlineHtml keeps a linked stylesheet's media scope when it inlines it", () => {
  const dir = assetDir();
  try {
    writeFileSync(join(dir, "screen.css"), "@page { size: A4 }");
    const out = inlineHtml(`<html><head><link rel="stylesheet" href="screen.css" media="screen"></head><body><div class="slide">1</div><div class="slide">2</div></body></html>`, { baseDir: dir });
    assert.match(out, /<style media="screen">@page \{ size: A4 \}<\/style>/);
    assert.equal(classifyLayout(out).layout, "deck");   // the screen-only @page does not demote the deck
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-050 (2): plain semantic <section>s are not slides; a deck must DECLARE itself", () => {
  // the old heuristic's trigger: 2+ plain sections → now a document
  assert.equal(isDeck(`<section>a</section><section>b</section>`), false);
  assert.equal(isDeck(`<section>1</section><section>2</section><section>3</section><section>4</section>`), false);
  assert.equal(isDeck(`<section>only one</section>`), false);
  assert.equal(isDeck(`<article><h1>Long article</h1><p>x</p></article>`), false);
  assert.equal(classifyLayout(`<section>a</section><section>b</section>`).source, "no deck declaration");
  // declared decks
  assert.equal(isDeck(`<div data-slide>a</div><div data-slide>b</div>`), true);
  assert.equal(isDeck(`<section class="slide">a</section><section class="slide">b</section>`), true);
  assert.equal(isDeck(DECK), true);
  assert.equal(isDeck(`<html data-wi-kind="deck"><body><section>a</section><section>b</section></body></html>`), true);
  assert.equal(classifyLayout(`<body data-wi-kind="deck"><section>a</section></body>`).source, LAYOUT_SOURCES.deckKind);
  // a nested inner marker must not flip a single-slide wrapper into a deck
  assert.equal(isDeck(`<div class="slide"><div class="slide">inner</div></div>`), false);
  // a carousel three levels deep is a component inside a page, not a deck
  assert.equal(isDeck(`<div class="wrap"><section class="features"><div class="carousel">` +
    `<div class="slide">1</div><div class="slide">2</div><div class="slide">3</div></div></section></div>`), false);
  // ...but slides inside ONE document-level wrapper are a deck
  assert.equal(isDeck(`<div class="wi-deck"><section class="wi-slide">1</section><section class="wi-slide">2</section></div>`), true);
});

test("F-050 (1): the doc's RECORDED style decides — web/doc/brochure are documents, ppt/slides are decks", () => {
  // brochure with .slide markers is still a brochure
  const d = classifyLayout(`<div class="slide">1</div><div class="slide">2</div>`, { style: "brochure" });
  assert.equal(d.layout, "document");
  assert.equal(d.source, "style: brochure");
  for (const style of ["web", "doc", "brochure"]) {
    assert.equal(classifyLayout(DECK, { style }).layout, "document", `style ${style}`);
  }
  // ppt with plain sections IS a deck (formats/ppt.md: one <section> = one slide)
  const e = classifyLayout(`<section>1</section><section>2</section>`, { style: "ppt" });
  assert.equal(e.layout, "deck");
  assert.equal(e.source, "style: ppt");
  assert.equal(e.slides.length, 2);
  assert.equal(e.page_size, DECK_PAGE_SIZE);
  // an EXPLICIT deck (recorded ppt) that also declares @page stays a deck — on the author's paper
  const explicit = classifyLayout(`<style>@page{size:A4 landscape}</style><section>1</section><section>2</section>`, { style: "ppt" });
  assert.equal(explicit.layout, "deck");
  assert.equal(explicit.page_size, "A4 landscape");
  assert.equal(explicit.slides.length, 2);
});

test("M2: an EXPLICIT deck declaration + author @page keeps one-slide-per-page on the author's paper", () => {
  const html = `<html data-wi-kind="deck"><head><style>@page { size: A4 landscape } .slide { height: 100vh }</style></head>` +
    `<body><section class="slide">1</section><section class="slide">2</section><section class="slide">3</section></body></html>`;
  const { html: out, layout } = decorateForExport(html, { withLayout: true });
  assert.equal(layout.layout, "deck");
  assert.equal(layout.source, LAYOUT_SOURCES.deckKind);
  assert.equal(layout.page_size, "A4 landscape");
  assert.equal(layout.author_geometry.at_page, true);
  assert.doesNotMatch(out, /13\.333in/);                       // the author's paper, no 16:9 injected
  assert.match(out, /@page \{ size: A4 landscape \}/);           // ...kept verbatim
  assert.equal((out.match(/wi-slide-top/g) || []).length >= 3, true);  // slides still paginate one per page
  assert.match(out, /\.wi-slide-top\s*\{[^}]*height:\s*100vh/);
  assert.match(out, /html, body \{ margin: 0; padding: 0; \}/);   // body reset rides with the slide geometry
  assert.match(out, /box-shadow:\s*none\s*!important/);           // deck baseline applies
  // the same via the recorded style
  const byStyle = decorateForExport(`<style>@page { size: A4 landscape }</style><section>1</section><section>2</section>`, { style: "ppt", withLayout: true });
  assert.equal(byStyle.layout.layout, "deck");
  assert.doesNotMatch(byStyle.html, /13\.333in/);
  assert.match(byStyle.html, /wi-slide-top/);
  // a WEAK marker (.slide) + author @page is still a document: the author's size, no deck pagination
  const weak = decorateForExport(`<style>@page { size: A4 landscape }</style><div class="slide">1</div><div class="slide">2</div>`, { withLayout: true });
  assert.equal(weak.layout.layout, "document");
  assert.doesNotMatch(weak.html, /wi-slide-top/);
});

test("deck-structured export gets the landscape @page; a tall doc does NOT", () => {
  const deck = decorateForExport(DECK);
  const doc = decorateForExport(
    `<html><head></head><body><article><h1>Article</h1>${"<p>para</p>".repeat(40)}</article></body></html>`
  );
  // Deck: forced 16:9 landscape + one-slide-per-page (gotchas #1, #5)
  assert.match(deck, /@page\s*\{\s*size:\s*13\.333in 7\.5in/);
  assert.match(deck, /break-after:\s*page/);
  assert.match(deck, /data-wi-layout="deck"/);
  // Deck baseline (issue #12 gotchas #3/#4) still applies to decks
  assert.match(deck, /box-shadow:\s*none\s*!important/);
  assert.match(deck, /text-shadow:\s*none\s*!important/);
  assert.match(deck, /-webkit-text-fill-color:\s*currentColor/);
  // Non-deck: NEVER the landscape @page (would break a scrolling doc)
  assert.doesNotMatch(doc, /@page\s*\{\s*size:\s*13\.333in 7\.5in/);
  assert.doesNotMatch(doc, /break-after:\s*page/);
  // ...but it still gets the render-safety baseline
  assert.match(doc, /animation:\s*none\s*!important/);
});

test("deck geometry tags only TOP-LEVEL slides — nested sections aren't forced to 100vh", () => {
  // two top-level slides; slide 2 wraps a nested <section> sub-layout
  const out = decorateForExport(
    `<html><head></head><body>` +
    `<section class="slide"><h1>Slide 1</h1></section>` +
    `<section class="slide"><h2>Slide 2</h2><section class="inner">nested layout</section></section>` +
    `</body></html>`
  );
  // exactly the 2 top-level slides carry wi-slide-top; the nested <section> does NOT
  assert.equal((out.match(/class="slide wi-slide-top"/g) || []).length, 2);
  assert.match(out, /class="inner"/);                 // nested section keeps its own class, untouched
  // the 100vh/overflow geometry targets the class, not the broad marker selector
  assert.match(out, /\.wi-slide-top\s*\{[^}]*height:\s*100vh/);
  assert.doesNotMatch(out, /\[data-slide\],\s*\.slide,\s*\.wi-slide\s*\{[^}]*100vh/);
});

test("a declared deck with its OWN page breaks keeps them: 16:9 @page added, slide geometry not forced", () => {
  const { html, layout } = decorateForExport(
    `<html><head><style>.slide { break-after: page; }</style></head><body>` +
    `<section class="slide">1</section><section class="slide">2</section></body></html>`,
    { withLayout: true },
  );
  assert.equal(layout.layout, "deck");
  assert.equal(layout.author_geometry.page_breaks, true);
  assert.match(html, /@page\s*\{\s*size:\s*13\.333in 7\.5in/);   // no author @page → ours fills the gap
  assert.doesNotMatch(html, /wi-slide-top/);                        // author paginates; we don't clip to 100vh
});

test("class/<style>-defined gradient text is neutralized in a DECK's print override (gotcha #3)", () => {
  const out = decorateForExport(
    `<html><head><style>.grad{background:linear-gradient(90deg,#f0f,#0ff);` +
    `-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head>` +
    `<body><section class="slide"><h1 class="grad">Hi</h1></section><section class="slide">2</section></body></html>`
  );
  // The collected selector list includes the class and neutralizes the clip.
  assert.match(out, /\.grad\s*\{/);
  assert.match(out, /background:\s*none\s*!important/);
  assert.match(out, /-webkit-text-fill-color:\s*currentColor\s*!important/);
});

test("a DOCUMENT's gradient text prints as authored — no neutralization (F-1 side effect)", () => {
  const out = decorateForExport(
    `<html><head><style>.grad{background:linear-gradient(90deg,#f0f,#0ff);` +
    `-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head>` +
    `<body><article><h1 class="grad">Hi</h1></article></body></html>`
  );
  assert.doesNotMatch(out, /-webkit-text-fill-color:\s*currentColor/);
  assert.doesNotMatch(out, /\.grad\s*\{[^}]*background:\s*none\s*!important/);
});

test("collectGradientClipSelectors: grouped selectors, multiple rules, @media skipped", () => {
  // background-clip:text + text-fill-color:transparent, grouped + standalone selectors
  const css = `
    .a, h1.grad { -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .plain { color: red; }
    .b { background-clip: text; }
    @media print { .nested { -webkit-background-clip: text; } }
  `;
  const sels = collectGradientClipSelectors(css);
  assert.deepEqual(sels, [".a, h1.grad", ".b"]); // .plain excluded; @media body skipped
});

test("a deck with NO gradient-clip rules gets no spurious extra override", () => {
  const out = decorateForExport(
    `<html><head><style>.x{color:red;background:linear-gradient(#fff,#000)}</style></head>` +
    `<body><section class="slide"><h1 class="x">Hi</h1></section><section class="slide">2</section></body></html>`
  );
  // The deck baseline injects exactly one currentColor fill (the inline-attribute selectors).
  const fillCount = (out.match(/-webkit-text-fill-color:\s*currentColor/g) || []).length;
  assert.equal(fillCount, 1);
  // And the appended-override class selector must not appear.
  assert.doesNotMatch(out, /\.x\s*\{[^}]*background:\s*none\s*!important/);
});

// --- F-050 (4): the export reports what it did ---------------------------------

test("inspectPdf reads page count + page size from a PDF; describePageSize names them", () => {
  const dir = assetDir();
  try {
    const pdf = join(dir, "t.pdf");
    writeFileSync(pdf, [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 594.96 841.92] >> endobj",
      "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 594.96 841.92] >> endobj",
      "trailer << /Root 1 0 R >>", "%%EOF",
    ].join("\n"));
    assert.deepEqual(inspectPdf(pdf), { pages: 2, page_size_pt: { width: 594.96, height: 841.92 }, page_size: "A4 portrait" });
    assert.deepEqual(inspectPdf(join(dir, "missing.pdf")), { pages: null, page_size_pt: null, page_size: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(describePageSize(960, 540), "16:9 (960 × 540 pt)");
  assert.equal(describePageSize(841.92, 594.96), "A4 landscape");
  assert.equal(describePageSize(612, 792), "Letter portrait");
  assert.equal(describePageSize(500, 700), "500 × 700 pt");
  assert.equal(describePageSize(0, 700), null);
});

test("exportPdf reports layout + page geometry (fake renderer → declared size, null pages)", async () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, BROCHURE);
    const fake = (h, p) => writeFileSync(p, "%PDF-1.4 fake");
    const r = await exportPdf(dir, 0, undefined, { renderer: fake });
    assert.equal(r.layout, "document");
    assert.equal(r.layout_source, "author @page");
    assert.equal(r.page_size, "A4 portrait");     // declared — the fake produced no readable PDF
    assert.equal(r.pages, null);
    assert.equal(r.page_size_pt, null);
    // and the PDF-prep copy carried no deck geometry
    const prep = readFileSync(join(dir, "exports", "export_v0.pdf.html"), "utf-8");
    assert.doesNotMatch(prep, /13\.333in|wi-slide-top/);
    assert.match(prep, /data-wi-layout="document"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/docs records `style` on the manifest; exports and GET /api/docs honour it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wi-exp-"));
  const { createMultiServer } = await import("../src/service/server.js");
  const svc = createMultiServer({ root, watch: false });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  try {
    // A brochure whose markup looks deck-ish (.slide markers) — the recorded style wins.
    let res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "print-piece", style: "brochure", html: `<div class="slide">1</div><div class="slide">2</div>` }),
    });
    assert.equal(res.status, 200);
    const manifest = JSON.parse(readFileSync(join(root, "print-piece", "versions.json"), "utf-8"));
    assert.equal(manifest.style, "brochure");
    const listed = (await (await fetch(`${base}/api/docs`)).json()).find((d) => d.name === "print-piece");
    assert.equal(listed.style, "brochure");
    res = await fetch(`${base}/d/print-piece/api/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, format: "html" }),
    });
    const body = await res.json();
    assert.equal(body.layout, "document");
    assert.equal(body.layout_source, "style: brochure");
    // No style requested → nothing recorded (manifest byte-shape unchanged for existing callers).
    res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "plain", html: `<h1>Hi</h1>` }),
    });
    assert.equal(res.status, 200);
    const plain = JSON.parse(readFileSync(join(root, "plain", "versions.json"), "utf-8"));
    assert.equal("style" in plain, false);
  } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

// --- L3: the export payload validates against its JSON schema (no runtime validator dependency) ---

// A minimal JSON-schema checker for the subset the event schemas use: type (incl. arrays with
// "null"), enum, required, properties, additionalProperties. Returns a list of violations.
function schemaViolations(schema, value, path = "$") {
  const out = [];
  const typeOf = (v) => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const t = typeOf(value);
    if (!allowed.includes(t) && !(t === "integer" && allowed.includes("number"))) out.push(`${path}: type ${t} not in ${allowed.join("|")}`);
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${path}: missing required ${k}`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) out.push(...schemaViolations(sub, value[k], `${path}.${k}`));
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in (schema.properties || {}))) out.push(`${path}: unexpected ${k}`);
    }
  }
  return out;
}

test("L3: the export response and the emitted export.generated payload validate against the event schema", async () => {
  const schema = JSON.parse(readFileSync(new URL("../src/service/event-schemas/wicked.interactive.export.generated.json", import.meta.url), "utf-8"));
  const root = mkdtempSync(join(tmpdir(), "wi-exp-"));
  const { createMultiServer } = await import("../src/service/server.js");
  const svc = createMultiServer({ root, watch: false });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  const ctrl = new AbortController();
  try {
    let res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "schema-doc", style: "brochure", html: BROCHURE }),
    });
    assert.equal(res.status, 200);
    // Listen on the SSE bridge for the export.generated frame (the bus poll is 500 ms).
    const sse = await fetch(`${base}/api/events`, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    const generated = (async () => {
      let buf = "";
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          if (ev !== "wicked.interactive.export.generated") continue;
          return JSON.parse(frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join(""));
        }
      }
      throw new Error("export.generated frame did not arrive in 10 s");
    })();
    res = await fetch(`${base}/d/schema-doc/api/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, format: "html" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The response carries the same report fields; validate them under the event schema's property rules.
    const shared = { document_id: "schema-doc", version: 0, format: body.format, path: body.path, file: body.file, download: body.download,
      layout: body.layout, layout_source: body.layout_source, page_size: body.page_size, pages: body.pages };
    assert.deepEqual(schemaViolations(schema, shared), []);
    assert.equal(body.layout, "document");
    assert.equal(body.layout_source, LAYOUT_SOURCES.documentStyle("brochure"));
    assert.equal(body.page_size, "A4 portrait");
    assert.equal(body.pages, null);
    // The live event envelope's payload validates as emitted.
    const event = await generated;
    const payload = event.payload ?? event;
    assert.deepEqual(schemaViolations(schema, payload), [], JSON.stringify(payload));
    assert.equal(payload.document_id, "schema-doc");
    assert.equal(payload.layout, "document");
    assert.equal(payload.layout_source, LAYOUT_SOURCES.documentStyle("brochure"));
    assert.equal(payload.page_size, "A4 portrait");
    assert.equal(payload.pages, null);
    // ...and the checker itself catches a wrong shape.
    assert.ok(schemaViolations(schema, { ...payload, layout: "poster", pages: "2" }).length >= 2);
  } finally { ctrl.abort(); await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

// --- F-050 integration: the real render (skipped when no Chrome/Chromium is installed) -----
//
// Verification note (html-craft.md): reproduce with the REAL `chromeRenderer` --print-to-pdf,
// not Playwright page.pdf — the two differ. Invariant: our PDF equals what Chrome prints of the
// author's own HTML (same page size, same page count) — font-independent, so it holds on any
// runner; on a machine with the brochure's fonts that is exactly 2 pages of A4.

const CHROME = findChrome();

test("F-050 integration: the A4 brochure exports as A4 pages — exactly as many as Chrome prints of the author's HTML", { skip: !CHROME && "no Chrome/Chromium installed" }, async (t) => {
  const dir = assetDir();
  try {
    initWorkspace(dir, BROCHURE);
    const r = await exportPdf(dir, 0);
    // Reference: Chrome printing the stored version with nothing but a document head, in the
    // SAME run (same Chrome, same fonts) — so the count is compared like for like.
    const refHtml = join(dir, "reference.html"), refPdf = join(dir, "reference.pdf");
    writeFileSync(refHtml, finalizeHtml(readFileSync(join(dir, "_v0.html"), "utf-8")));
    await chromeRenderer(refHtml, refPdf, {});
    const ref = inspectPdf(refPdf);
    t.diagnostic(`brochure export: ${r.pages} page(s) ${r.page_size}; Chrome reference: ${ref.pages} page(s) ${ref.page_size}`);
    assert.equal(r.layout, "document");
    assert.equal(r.page_size, "A4 portrait", `page size ${JSON.stringify(r.page_size_pt)}`);
    assert.equal(ref.page_size, "A4 portrait");
    assert.equal(typeof ref.pages, "number");
    assert.equal(r.pages, ref.pages, `export ${r.pages} pages vs Chrome reference ${ref.pages}`);  // exact — no tolerance
    assert.notEqual(r.page_size_pt.width, 960);  // never the 16:9 slide page
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M2 integration: an explicit deck + author @page renders N slides on the author's paper — no blank page", { skip: !CHROME && "no Chrome/Chromium installed" }, async () => {
  const dir = assetDir();
  try {
    // The marker rides on a wrapper: the version store keeps body CONTENT only, so an attribute
    // on <html>/<body> would not survive into _v0.html (documented in html-craft.md).
    initWorkspace(dir, `<style>@page { size: A4 landscape } .slide { height: 100vh; background: #123; color: #fff }</style>` +
      `<div data-wi-kind="deck"><section class="slide">1</section><section class="slide">2</section><section class="slide">3</section></div>`);
    const r = await exportPdf(dir, 0);
    assert.equal(r.layout, "deck");
    assert.equal(r.pages, 3, `3 slides → 3 pages, got ${r.pages}`);
    assert.equal(r.page_size, "A4 landscape");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F-050 integration: a DECLARED deck still renders 16:9, one slide per page", { skip: !CHROME && "no Chrome/Chromium installed" }, async () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, DECK);
    const r = await exportPdf(dir, 0);
    assert.equal(r.layout, "deck");
    assert.equal(r.pages, 3);
    assert.equal(r.page_size, "16:9 (960 × 540 pt)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/export html returns a self-contained file path", async () => {
  const dir = assetDir();
  initWorkspace(dir, `<h1>Title</h1><img src="logo.png">`);
  const svc = createServer({ dir, watch: false });
  const port = await svc.start(0);
  try {
    const res = await fetch(`http://localhost:${port}/api/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, format: "html" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.format, "html");
    assert.ok(existsSync(body.path));
    assert.match(readFileSync(body.path, "utf-8"), /data:image\/png/);
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
