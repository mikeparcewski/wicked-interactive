// Browser-driven acceptance test — the inline-comment journey (ADR-0013), in a real browser.
// Since every comment is agent-mediated now, the test plays a STUB agent: it watches the
// workspace requests/, and fulfills each structural request by replacing the targeted
// fragment's inner text (preserving data-wid). Covers AC-3/5/6 + the agent loop + AC-15/20/24.
// Exit 0 = PASS.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { createServer } from "../src/service/server.js";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import { findChrome } from "../src/service/export.js";

process.env.WICKED_NO_BUS = "1";
const FRONTEND_DIST = resolve(import.meta.dirname, "../frontend/dist");
const step = (m) => console.log(`  • ${m}`);

const chrome = findChrome();
if (!chrome) { console.error("SKIP: no Chrome/Chromium found (set WI_CHROME)"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "wi-e2e-"));
initWorkspace(dir, "<section><h1>Original Heading</h1><p>Original paragraph.</p></section>");
const svc = createServer({ dir, watch: true, frontendDir: FRONTEND_DIST });
const port = await svc.start(0);

// Stub agent: fulfill any pending structural request by setting the fragment's inner text.
let stubStop = false;
const NEW_TEXT = "ACCEPTANCE HEADING";
(async function stubAgent() {
  const reqDir = join(dir, "requests");
  while (!stubStop) {
    if (existsSync(reqDir)) {
      for (const f of readdirSync(reqDir).filter((n) => /^_v\d+\.request\.json$/.test(n))) {
        const respName = f.replace(".request.json", ".response.json");
        if (existsSync(join(reqDir, respName))) continue;
        const req = JSON.parse(readFileSync(join(reqDir, f), "utf-8"));
        const results = req.items.map((it) => ({
          selector: it.selector,
          fragment: it.fragment.replace(/^(<[^>]+>)[\s\S]*(<\/[^>]+>)$/, `$1${NEW_TEXT}$2`),
        }));
        writeFileSync(join(reqDir, respName), JSON.stringify({ version: req.version, results }));
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
})();

const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox"] });
let ok = false;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
  step("app loaded");

  await page.waitForSelector("iframe");
  const frame = await (await page.$("iframe")).contentFrame();
  await frame.waitForSelector('[data-wid="slide-0-heading-1"]', { timeout: 10000 });
  step("document rendered with data-wid anchors (AC-3)");

  await frame.click('[data-wid="slide-0-heading-1"]');
  await page.waitForSelector(".wi-inline textarea", { timeout: 10000 });
  step("clicked a block -> inline comment box opened (AC-5/6)");

  await page.type(".wi-inline textarea", "change this heading");
  await page.click(".wi-inline button[type=submit]"); // Send -> agent-mediated edit
  step("sent a comment (agent-mediated)");

  // The stub agent fulfills; the finalized version should hot-reload into view.
  await page.waitForFunction((t) => {
    const f = document.querySelector("iframe");
    try { return new RegExp(t).test(f.contentDocument.body.innerHTML); } catch { return false; }
  }, { timeout: 15000 }, NEW_TEXT);
  step("agent applied the edit -> live hot-reload (agent loop + AC-15)");

  await page.waitForFunction(
    () => [...document.querySelectorAll(".wi-vsel option")].length >= 2,
    { timeout: 5000 },
  );
  step("version dropdown updated (AC-20)");

  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Export HTML");
    return b && !b.disabled;
  }, { timeout: 10000 });
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export HTML").click();
  });
  await page.waitForFunction(
    () => /Exported HTML/.test(document.querySelector(".wi-status")?.textContent || ""),
    { timeout: 10000 },
  );
  step("exported self-contained HTML from the browser (AC-24/26)");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join("; ")}`);
  if (!loadManifest(dir).versions.some((v) => v.feedback_file?.endsWith(".response.json"))) {
    throw new Error("expected an agent-finalized version");
  }

  console.log("\nACCEPTANCE PASS — inline-comment + agent loop verified in a real browser.");
  ok = true;
} catch (e) {
  console.error("\nACCEPTANCE FAIL:", e.message);
} finally {
  stubStop = true;
  await browser.close();
  await svc.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
