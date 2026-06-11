// theme-grab.js — the deterministic, model-free "grab a URL to a PDF" primitive
// (the service half of "learn a theme from a URL", ADR-0010/ADR-0020).
//
// Judgment (reading the captured design — palette, type scale, spacing, card treatment) is the
// AGENT's job and lives in the assist skill. This module does NOTHING intelligent: it points a
// headless browser at a LIVE https URL and prints it to PDF, exactly the same `chrome
// --print-to-pdf` primitive that export.js uses for a version's HTML — only the final argument
// is the live URL instead of `file://<html>`. We REUSE export.js's findChrome() so chrome
// discovery (and the WI_CHROME override / clear "no Chrome found" error) stays in one place and
// adds no new install surface.
//
// The renderer is injectable so tests can pass a fake (the proven export.test.js fakeRenderer
// pattern) and CI never needs a real browser or network.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { findChrome as defaultFindChrome } from "./export.js";

/** True for a well-formed http(s) URL — mirrors server.js's demo-url validation. */
function isHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Default URL renderer: headless Chrome `--print-to-pdf` over a LIVE https URL.
 *
 * Sibling of export.js's chromeRenderer — identical flags, but the last argument is the live
 * URL, not `file://<html>`. New headless renders whatever Chrome paints at the default viewport
 * with no settle wait (a known limitation for JS-heavy / cookie-walled pages — see the plan's
 * risks; the injectable seam lets a maintainer drop in a Playwright/crawlee renderer later).
 * A missing Chrome degrades to the same clear "set WI_CHROME" error as PDF export.
 *
 * @param {string} url      live http(s) URL to capture
 * @param {string} pdfPath  absolute path to write the PDF to
 * @param {object} [opts]   { chromePath?, noHeaderFooter = true, args = [], findChrome? }
 *                          `findChrome` is injectable so the no-Chrome error path is testable on
 *                          a machine that DOES have Chrome installed (defaults to export.js's).
 */
export function chromeUrlRenderer(url, pdfPath, opts = {}) {
  const { chromePath, noHeaderFooter = true, args = [], findChrome = defaultFindChrome } = opts;
  const chrome = findChrome(chromePath);
  if (!chrome) throw new Error("no Chrome/Chromium found for URL render (set WI_CHROME)");
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox"];
  if (noHeaderFooter) flags.push("--no-pdf-header-footer");
  flags.push(...args, `--print-to-pdf=${pdfPath}`, url);
  const r = spawnSync(chrome, flags, { timeout: 60000 });
  if (r.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`chrome URL render failed (status ${r.status}): ${r.stderr?.toString().slice(0, 300)}`);
  }
}

/**
 * Grab a live URL to a PDF at `outPath`. Validates the URL is http(s) BEFORE spawning anything
 * (no SSRF surprises beyond what the existing demo path already allows), then delegates to the
 * injectable `renderer`. Returns the path it wrote, so the caller can announce it on the bus.
 *
 * @param {string} url
 * @param {string} outPath  absolute path for the rendered PDF
 * @param {object} [opts]   { renderer = chromeUrlRenderer, chromePath?, renderOpts? }
 * @returns {{ path: string }}
 */
export function grabUrlToPdf(url, outPath, { renderer = chromeUrlRenderer, chromePath, renderOpts = {} } = {}) {
  if (!isHttpUrl(url)) throw new Error(`theme URL must be a valid http(s) URL: ${url}`);
  renderer(url, outPath, { chromePath, ...renderOpts });
  return { path: outPath };
}
