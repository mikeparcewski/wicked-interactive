// Browser-driven acceptance test — the real business-user journey, in a real browser.
// Drives the built React app against a live service with puppeteer-core + system Chrome.
//
// Covers: AC-3 (renders in browser), AC-5/6 (block select + feedback), AC-8 (UPDATE writes
// feedback), AC-11/12 (deterministic regenerate), AC-15 (hot-reload without navigation),
// AC-20 (version strip), AC-24/26 (browser-triggered export). Exit 0 = PASS.

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { createServer } from "../../src/service/server.js";
import { initWorkspace, loadManifest } from "../../src/service/workspace.js";
import { findChrome } from "../../src/service/export.js";

process.env.WICKED_NO_BUS = "1";
const FRONTEND_DIST = resolve(import.meta.dirname, "../../frontend/dist");

function step(msg) { console.log(`  • ${msg}`); }

const chrome = findChrome();
if (!chrome) { console.error("SKIP: no Chrome/Chromium found (set WI_CHROME)"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "wi-e2e-"));
initWorkspace(dir, "<section><h1>Original Heading</h1><p>Original paragraph.</p></section>");
const svc = createServer({ dir, watch: true, frontendDir: FRONTEND_DIST });
const port = await svc.start(0);
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox"] });

let ok = false;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // NB: not networkidle0 — the SSE (/events) stream stays open, so the network is never idle.
  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
  step("app loaded");

  await page.waitForSelector("iframe");
  const frame = await (await page.$("iframe")).contentFrame();
  await frame.waitForSelector('[data-wid="slide-0-heading-1"]', { timeout: 10000 });
  step("document rendered with data-wid anchors (AC-3)");

  // Business user clicks the heading block -> the feedback panel opens in the parent.
  await frame.click('[data-wid="slide-0-heading-1"]');
  await page.waitForSelector(".wi-panel textarea", { timeout: 10000 });
  step("clicked a block -> feedback panel opened (AC-5/6)");

  // Replace the text and add the feedback item.
  await page.click(".wi-panel textarea", { clickCount: 3 });
  await page.keyboard.type("ACCEPTANCE HEADING");
  await page.click(".wi-panel button[type=submit]");
  await page.waitForFunction(
    () => /\(1\)/.test(document.querySelector(".wi-btn--primary")?.textContent || ""),
    { timeout: 5000 },
  );
  step("feedback added (pending count = 1)");

  // UPDATE -> service writes _v1.md -> watcher regenerates -> SSE -> iframe swaps.
  await page.click(".wi-btn--primary");
  await page.waitForFunction(() => {
    const f = document.querySelector("iframe");
    try { return /ACCEPTANCE HEADING/.test(f.contentDocument.body.innerHTML); }
    catch { return false; }
  }, { timeout: 12000 });
  step("UPDATE -> live hot-reload shows the edit without navigation (AC-8/11/12/15)");

  await page.waitForFunction(
    () => [...document.querySelectorAll(".wi-chip")].some((c) => /v1/.test(c.textContent)),
    { timeout: 5000 },
  );
  step("version strip shows v1 (AC-20)");

  // Export to self-contained HTML from the browser.
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export HTML").click();
  });
  await page.waitForFunction(
    () => /Exported HTML/.test(document.querySelector(".wi-status")?.textContent || ""),
    { timeout: 10000 },
  );
  step("exported self-contained HTML from the browser (AC-24/26)");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join("; ")}`);
  const m = loadManifest(dir);
  if (m.head !== 1) throw new Error(`expected head=1, got ${m.head}`);

  console.log("\nACCEPTANCE PASS — full business-user loop verified in a real browser.");
  ok = true;
} catch (e) {
  console.error("\nACCEPTANCE FAIL:", e.message);
} finally {
  await browser.close();
  await svc.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
