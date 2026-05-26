import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inlineHtml, exportHtml, exportPdf } from "../src/service/export.js";
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
