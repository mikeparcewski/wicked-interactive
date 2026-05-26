// export.js — export a version to a self-contained interactive HTML or a PDF (ADR-0009).
//
// HTML: inline local stylesheets, scripts, images (data-URI), and url() refs inside inlined
//       CSS, so the file renders + stays interactive opened straight from disk (no server).
// PDF:  render the self-contained HTML via headless Chrome (the primitive wicked-prezzie
//       wraps; wicked-prezzie itself is a plugin/skill, not an importable library).

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
  const html = inlineHtml(readVersionHtml(dir, version), { baseDir: dir });
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

/** Default PDF renderer: headless Chrome --print-to-pdf over the self-contained HTML. */
export function chromeRenderer(htmlPath, pdfPath, { chromePath } = {}) {
  const chrome = findChrome(chromePath);
  if (!chrome) throw new Error("no Chrome/Chromium found for PDF render (set WI_CHROME)");
  const r = spawnSync(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { timeout: 60000 });
  if (r.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`chrome PDF render failed (status ${r.status}): ${r.stderr?.toString().slice(0, 300)}`);
  }
}

/**
 * Export version → PDF. First builds the self-contained HTML, then renders it.
 * `renderer(htmlPath, pdfPath, opts)` is injectable (tests pass a fake).
 * @returns {{ path: string }}
 */
export function exportPdf(dir, version, outPath, { renderer = chromeRenderer, chromePath } = {}) {
  const { path: htmlPath } = exportHtml(dir, version, join(exportsDir(dir), `export_v${version}.pdf.html`));
  const path = outPath || join(exportsDir(dir), `export_v${version}.pdf`);
  renderer(htmlPath, path, { chromePath });
  return { path };
}
