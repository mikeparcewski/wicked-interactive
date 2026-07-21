// Browser-driven acceptance (ADR-0019): the full bus loop through a real browser. A stub
// "agent" subscribes to the bus, ASKS a clarifying question via wicked.interactive.status.posted, reads
// the user's wicked.interactive.question.answered, and fulfils with wicked.interactive.edit.completed — exercising the
// inline-comment + clarification + hot-reload path entirely over wicked-bus. Exit 0 = PASS.

import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-e2e-bus-"));
const { createMultiServer } = await import("../src/service/server.js");
const { emitEvent, startSubscription } = await import("../src/service/bus-client.js");
const { ALL_FILTER, PRODUCERS } = await import("../src/service/events.js");
const { loadManifest } = await import("../src/service/workspace.js");
const { findChrome } = await import("../src/service/export.js");

const FRONTEND_DIST = resolve(import.meta.dirname, "../frontend/dist");
const ANSWER = "PICKED NAME";
const DOC = "e2e";
const step = (m) => console.log(`  • ${m}`);

const chrome = findChrome();
if (!chrome) { console.error("SKIP: no Chrome/Chromium found (set WI_CHROME)"); process.exit(2); }

const root = mkdtempSync(join(tmpdir(), "wi-e2e-"));
const svc = createMultiServer({ root, frontendDir: FRONTEND_DIST });
const port = await svc.start(0);
const base = `http://localhost:${port}`;

// Create the doc up front (the browser opens ?doc=e2e).
await fetch(`${base}/api/docs`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: DOC, html: "<section><h1>Original Heading</h1><p>Original paragraph.</p></section>" }),
});

// Stub agent on the bus: ask once per structural batch, then fulfil from the answer.
const pendingByRid = new Map();   // request_id -> { version, items }
let stub;
stub = startSubscription({
  plugin: "e2e-stub-agent", filter: ALL_FILTER, cursorInit: "latest",
  handler: async (event) => {
    const p = event.payload || {};
    if (p.document_id !== DOC) return;
    if (event.event_type === "wicked.interactive.feedback.processed" && event.producer_id === PRODUCERS.SERVICE) {
      if ((p.awaiting_structural || 0) > 0) {
        const rid = `q-v${p.version}`;
        if (pendingByRid.has(rid)) return;
        pendingByRid.set(rid, { version: p.version, items: p.structural_items });
        await emitEvent("wicked.interactive.status.posted",
          { document_id: DOC, state: "asking", question: "Pick a name:", options: [ANSWER, "other"], request_id: rid },
          { producer: PRODUCERS.AGENT });
      }
    } else if (event.event_type === "wicked.interactive.question.answered" && event.producer_id === PRODUCERS.UI) {
      const job = pendingByRid.get(p.request_id);
      if (!job) return;
      const results = job.items.map((it) => ({
        selector: it.selector,
        fragment: it.fragment.replace(/^(<[^>]+>)[\s\S]*(<\/[^>]+>)$/, `$1${p.answer}$2`),
      }));
      await emitEvent("wicked.interactive.edit.completed", { document_id: DOC, version: job.version, results }, { producer: PRODUCERS.AGENT });
    }
  },
});

const browser = await puppeteer.launch({ executablePath: chrome, headless: "new", args: ["--no-sandbox"] });
let ok = false;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${base}/?doc=${DOC}`, { waitUntil: "load" });
  await page.waitForSelector("iframe");
  const frame = await (await page.$("iframe")).contentFrame();
  await frame.waitForSelector('[data-wid="slide-0-heading-1"]', { timeout: 10000 });
  step("document rendered (AC-3)");

  // Dispatch click from within the iframe's JS context: CDP Input.dispatchMouseEvent does not
  // correctly route cross-frame events to the iframe's contentDocument listeners in headless
  // Chrome, so we use a programmatic event to reliably trigger the React click handler.
  await frame.evaluate(() => {
    const el = document.querySelector('[data-wid="slide-0-heading-1"]');
    if (!el) throw new Error('slide-0-heading-1 not found in iframe');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForSelector(".wi-inline textarea", { timeout: 10000 });
  await page.type(".wi-inline textarea", "improve this");
  // Wait for React to enable the submit button (disabled={!text.trim()} until state updates).
  // Use el && !el.disabled rather than !el?.disabled — the latter is true when el is null.
  await page.waitForFunction(() => { const el = document.querySelector(".wi-inline button[type=submit]"); return el && !el.disabled; }, { timeout: 5000 });
  // Use programmatic click to avoid CDP input routing issues (same fix as iframe click)
  await page.evaluate(() => {
    const btn = document.querySelector(".wi-inline button[type=submit]");
    if (!btn) throw new Error(".wi-inline button[type=submit] not found");
    btn.click();
  });
  step("sent an inline comment (bus: wicked.interactive.feedback.submitted)");

  // The agent asks; the question + options must appear in the browser (bus: status.posted).
  await page.waitForSelector(".wi-thread__opts button", { timeout: 20000 });
  step("agent's clarifying question appeared in the browser (status channel over the bus)");

  await page.evaluate((ans) => {
    const btn = [...document.querySelectorAll(".wi-thread__opts button")].find((b) => b.textContent.trim() === ans);
    if (!btn) throw new Error(`answer button "${ans}" not found in .wi-thread__opts`);
    btn.click();
  }, ANSWER);
  step("answered the question (bus: wicked.interactive.question.answered)");

  await page.waitForFunction((t) => {
    const f = document.querySelector("iframe");
    try { return new RegExp(t).test(f.contentDocument.body.innerHTML); } catch { return false; }
  }, { timeout: 20000 }, ANSWER);
  step("agent applied the answer -> hot-reload (wicked.interactive.version.created → iframe reload verified)");

  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "HTML");
    return b && !b.disabled;
  }, { timeout: 10000 });
  step("stage unlocked after completion");

  // Version rewind (AC-20..22): select v0 via VersionStrip dropdown → iframe shows original (no ANSWER).
  // Assert the VersionStrip is present and at a real numeric version > 0 before rewinding.
  const headVer = await page.evaluate(() => {
    const sel = document.querySelector(".wi-vsel select");
    if (!sel) throw new Error(".wi-vsel select not found — VersionStrip must be visible after a structural edit");
    const v = Number(sel.value);
    if (!Number.isFinite(v) || v < 1) throw new Error(`.wi-vsel select value "${sel.value}" is not a valid head version ≥ 1`);
    return v;
  });
  await page.evaluate(() => {
    const sel = document.querySelector(".wi-vsel select");
    sel.value = "0";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction((ans) => {
    const f = document.querySelector("iframe");
    try { return !new RegExp(ans).test(f.contentDocument.body.innerHTML); } catch { return false; }
  }, { timeout: 10000 }, ANSWER);
  step("version rewind: v0 in VersionStrip restores original content (no ANSWER text in iframe)");
  // Restore to head before the chat step
  await page.evaluate((v) => {
    const sel = document.querySelector(".wi-vsel select");
    sel.value = String(v);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, headVer);
  await page.waitForFunction((ans) => {
    const f = document.querySelector("iframe");
    try { return new RegExp(ans).test(f.contentDocument.body.innerHTML); } catch { return false; }
  }, { timeout: 10000 }, ANSWER);

  // Conversational panel round-trip (ADR-0014): a chat message appears in the transcript.
  await page.type(".wi-bar textarea", "make the whole page more premium");
  // Wait for React to enable the submit button (disabled while busy/sending or text empty).
  // Use el && !el.disabled rather than !el?.disabled — the latter is true when el is null.
  await page.waitForFunction(() => { const el = document.querySelector(".wi-bar button[type=submit]"); return el && !el.disabled; }, { timeout: 10000 });
  await page.evaluate(() => {
    const btn = document.querySelector(".wi-bar button[type=submit]");
    if (!btn) throw new Error(".wi-bar button[type=submit] not found");
    btn.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".wi-msg--user")].some((m) => /premium/.test(m.textContent)),
    { timeout: 10000 },
  );
  step("chat message round-trips into the transcript (bus: wicked.interactive.chat.posted)");

  if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join("; ")}`);
  const m = loadManifest(join(root, DOC));
  if (m.head < 2) throw new Error(`expected an agent-finalized structural version (head=${m.head})`);

  console.log("\nACCEPTANCE PASS — inline comment + ask/answer clarification loop verified over the bus in a real browser.");
  ok = true;
} catch (e) {
  console.error("\nACCEPTANCE FAIL:", e.message);
} finally {
  try { await stub.stop(); } catch {}
  await browser.close();
  await svc.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.WICKED_BUS_DATA_DIR, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
