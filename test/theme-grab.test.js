// theme-grab.test.js — the DETERMINISTIC grab→PDF primitive (ADR-0010/ADR-0020).
// Modeled on export.test.js's injectable-renderer tests so CI needs no real browser or network.
// We do NOT test the vision synthesis of a theme — that is an agent skill step (Step 8.5), not
// service code, and there's nothing deterministic to assert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grabUrlToPdf, chromeUrlRenderer } from "../src/service/theme-grab.js";

process.env.WICKED_NO_BUS = "1";

function tmp() {
  return mkdtempSync(join(tmpdir(), "wi-theme-"));
}

test("grabUrlToPdf delegates to the renderer with the LIVE url and writes a PDF", () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    let seenUrl = null, seenPath = null;
    const fakeRenderer = (url, pdfPath) => {
      seenUrl = url;
      seenPath = pdfPath;
      // The renderer is the only thing that touches a browser; it writes the PDF bytes.
      mkdirSync(dir, { recursive: true });
      writeFileSync(pdfPath, "%PDF-1.4 fake");
    };
    const { path } = grabUrlToPdf("https://example.com/pricing", out, { renderer: fakeRenderer });
    assert.equal(path, out, "returns the requested out path");
    assert.ok(existsSync(path), "a PDF file was written");
    assert.match(readFileSync(path, "utf-8"), /^%PDF/);
    // The renderer must receive the LIVE https URL, NOT a file:// path (the whole point — we
    // grab a page that lives on the network, not a local HTML file like export.js does).
    assert.equal(seenUrl, "https://example.com/pricing");
    assert.doesNotMatch(seenUrl, /^file:\/\//);
    assert.equal(seenPath, out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("grabUrlToPdf rejects a non-http(s) url with a clear error (before spawning)", () => {
  let calls = 0;
  const fakeRenderer = () => { calls++; };
  assert.throws(
    () => grabUrlToPdf("ftp://internal/secret", "/tmp/x.pdf", { renderer: fakeRenderer }),
    /valid http\(s\) URL/,
  );
  assert.throws(
    () => grabUrlToPdf("not a url at all", "/tmp/x.pdf", { renderer: fakeRenderer }),
    /valid http\(s\) URL/,
  );
  assert.equal(calls, 0, "the renderer is never invoked for an invalid url");
});

test("chromeUrlRenderer throws a clear 'set WI_CHROME' error when no Chrome is found", () => {
  // Inject a chrome-finder that misses (returns null) so the error path is deterministic even on
  // a dev machine that DOES have Chrome at a default location. It must throw BEFORE spawning.
  assert.throws(
    () => chromeUrlRenderer("https://example.com", "/tmp/nope.pdf", { findChrome: () => null }),
    /no Chrome\/Chromium found.*WI_CHROME/,
  );
});
