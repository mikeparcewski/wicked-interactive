import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inlineHtml, exportHtml, exportPdf, decorateForExport, isDeck, collectGradientClipSelectors } from "../src/service/export.js";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";

process.env.WICKED_NO_BUS = "1";

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

test("exportPdf builds the self-contained HTML and delegates to the renderer", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, `<h1>Title</h1>`);
    let renderedHtmlPath = null;
    const fakeRenderer = (htmlPath, pdfPath) => {
      renderedHtmlPath = htmlPath;
      assert.ok(existsSync(htmlPath), "renderer receives a real self-contained HTML file");
      writeFileSync(pdfPath, "%PDF-1.4 fake");
    };
    const { path } = exportPdf(dir, 0, undefined, { renderer: fakeRenderer });
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, "utf-8"), /^%PDF/);
    assert.ok(renderedHtmlPath && existsSync(renderedHtmlPath));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- issue #12: print contract --------------------------------------------

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

test("exported HTML always injects the universally-safe print baseline", () => {
  const dir = assetDir();
  try {
    initWorkspace(dir, `<h1>Title</h1>`);
    const out = readFileSync(exportHtml(dir, 0).path, "utf-8");
    // box-shadow / text-shadow killed (gotcha #4)
    assert.match(out, /box-shadow:\s*none\s*!important/);
    assert.match(out, /text-shadow:\s*none\s*!important/);
    // color-adjust kept exact so dark bg + real gradient FILLS survive (the GOOD one)
    assert.match(out, /print-color-adjust:\s*exact/);
    assert.match(out, /-webkit-print-color-adjust:\s*exact/);
    // gradient-clipped text neutralized to a solid (gotcha #3)
    assert.match(out, /-webkit-text-fill-color:\s*currentColor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isDeck: 2+ slide containers is a deck; single/none is not", () => {
  assert.equal(isDeck(`<section>a</section><section>b</section>`), true);
  assert.equal(isDeck(`<div data-slide>a</div><div data-slide>b</div>`), true);
  assert.equal(isDeck(`<section>only one</section>`), false);     // one-pager wrapper
  assert.equal(isDeck(`<article><h1>Long article</h1><p>x</p></article>`), false);
  // a nested inner <section> must not flip a single-section one-pager into a deck
  assert.equal(isDeck(`<section><section>inner</section></section>`), false);
});

test("deck-structured export gets the landscape @page; a tall doc does NOT", () => {
  const deck = decorateForExport(
    `<html><head></head><body><section><h1>Slide 1</h1></section><section><h2>Slide 2</h2></section></body></html>`
  );
  const doc = decorateForExport(
    `<html><head></head><body><article><h1>Article</h1>${"<p>para</p>".repeat(40)}</article></body></html>`
  );
  // Deck: forced 16:9 landscape + one-slide-per-page (gotchas #1, #5)
  assert.match(deck, /@page\s*\{\s*size:\s*13\.333in 7\.5in/);
  assert.match(deck, /break-after:\s*page/);
  // Non-deck: baseline only, NEVER the landscape @page (would break a scrolling doc)
  assert.doesNotMatch(doc, /@page\s*\{\s*size:\s*13\.333in 7\.5in/);
  assert.doesNotMatch(doc, /break-after:\s*page/);
  // ...but it still gets the universally-safe baseline
  assert.match(doc, /box-shadow:\s*none\s*!important/);
});

test("class/<style>-defined gradient text is neutralized in the print override (gotcha #3)", () => {
  const out = decorateForExport(
    `<html><head><style>.grad{background:linear-gradient(90deg,#f0f,#0ff);` +
    `-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head>` +
    `<body><h1 class="grad">Hi</h1></body></html>`
  );
  // The collected selector list includes the class and neutralizes the clip.
  assert.match(out, /\.grad\s*\{/);
  assert.match(out, /background:\s*none\s*!important/);
  assert.match(out, /-webkit-text-fill-color:\s*currentColor\s*!important/);
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

test("a doc with NO gradient-clip rules gets no spurious extra override", () => {
  const out = decorateForExport(
    `<html><head><style>.x{color:red;background:linear-gradient(#fff,#000)}</style></head>` +
    `<body><h1 class="x">Hi</h1></body></html>`
  );
  // The only @media print blocks are the baseline (1) — no appended class override.
  // The baseline injects exactly one currentColor fill (the inline-attribute selectors).
  const fillCount = (out.match(/-webkit-text-fill-color:\s*currentColor/g) || []).length;
  assert.equal(fillCount, 1);
  // And the appended-override class selector must not appear.
  assert.doesNotMatch(out, /\.x\s*\{[^}]*background:\s*none\s*!important/);
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
