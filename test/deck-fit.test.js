import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { deckFit } from "../src/service/deck-fit.js";

function fixture(t, declared = 'data-stated-slides="2"') {
  const dir = mkdtempSync(join(tmpdir(), "wi-fit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, `<main data-wi-kind="deck" ${declared}><section data-wid="first"><h1>One</h1></section><section data-wid="second"><h1>Two</h1></section></main>`, { style: "ppt" });
  return dir;
}
function fakePlaywright(overflows = [0, 2]) {
  const state = { closed: 0, launch: null, page: null, html: null, media: null };
  const elements = overflows.map((overflow, index) => ({
    clientHeight: 1080, scrollHeight: 1080 + overflow, clientWidth: 1920, scrollWidth: index === 1 ? 1920 + overflow : 1920,
    style: { setProperty: () => {} }, getAttribute: (name) => name === "data-wid" ? `slide-${index}` : name === "data-slide-id" && index === 0 ? "deck-s1" : null,
  }));
  const page = {
    emulateMedia: async (opts) => { state.media = opts; },
    setContent: async (html) => { state.html = html; },
    evaluate: async (fn) => {
      const data = await runInNewContext(`(${fn.toString()})()`, { document: { fonts: { ready: Promise.resolve() }, querySelectorAll: () => elements }, getComputedStyle: () => ({ display: "flex" }) });
      return JSON.parse(JSON.stringify(data));
    },
  };
  const importPlaywright = async () => ({ chromium: { launch: async (opts) => {
    state.launch = opts;
    return { newPage: async (options) => { state.page = options; return page; }, close: async () => { state.closed++; } };
  } } });
  return { importPlaywright, state, page };
}
test("fit renders export slides at 1080p, measures both axes and allows two pixels", async (t) => {
  const dir = fixture(t), fake = fakePlaywright();
  const result = await deckFit(dir, {}, fake);
  assert.deepEqual(result, { version: 0, slides: [
    { id: "deck-s1", index: 0, overflowPx: 0, overflow: false }, // the deck's slide id wins over the anchor
    { id: "slide-1", index: 1, overflowPx: 2, overflow: false },
  ], stated: 2, actual: 2, ok: true });
  assert.equal(fake.state.launch.headless, true);
  assert.deepEqual(fake.state.page.viewport, { width: 1920, height: 1080 });
  // Screen media and no export decoration: the authored deck, as the editor presents it.
  assert.equal(fake.state.media, null);
  assert.doesNotMatch(fake.state.html, /wi-slide-top/);
  assert.match(fake.state.html, /data-wi-fit-index="0"/);
  assert.match(fake.state.html, /data-wi-fit-index="1"/);
  assert.equal(fake.state.closed, 1);
});
test("fit reports overflows, explicit count mismatches, and absent stated counts", async (t) => {
  const dir = fixture(t, "");
  const fake = fakePlaywright([0, 3]);
  const result = await deckFit(dir, {}, fake);
  assert.equal(result.slides[1].overflowPx, 3);
  assert.equal(result.slides[1].overflow, true);
  assert.equal(result.stated, null);
  assert.equal(result.ok, false);
  assert.equal((await deckFit(dir, { stated: 3 }, fakePlaywright())).ok, false);
  assert.equal((await deckFit(dir, { stated: 2 }, fakePlaywright())).ok, true);
});
test("fit validates version and stated count and closes the browser on measurement failure", async (t) => {
  const dir = fixture(t), fake = fakePlaywright();
  for (const body of [{ version: 99 }, { version: "0" }, { stated: -1 }, { stated: 1.5 }, { stated: "2" }, { extra: true }]) {
    await assert.rejects(deckFit(dir, body, fake), (e) => e.status === 400);
  }
  fake.page.evaluate = async () => { throw new Error("measure failed"); };
  await assert.rejects(deckFit(dir, {}, fake), /measure failed/);
  assert.equal(fake.state.closed, 1);
});
test("the render browser: an override wins; else Playwright's own; a system Chrome only when the bundled one is missing", async (t) => {
  const { launchRenderBrowser } = await import("../src/service/export.js");
  // The acceptance job pins WI_CHROME: this test sets the environment it asserts on, and restores it.
  const pinned = process.env.WI_CHROME;
  delete process.env.WI_CHROME;
  t.after(() => { if (pinned === undefined) delete process.env.WI_CHROME; else process.env.WI_CHROME = pinned; });
  const seen = [];
  const playwright = (failWith) => async () => ({ chromium: { launch: async (o) => {
    seen.push(o.executablePath ?? "bundled");
    if (failWith && !o.executablePath) throw new Error(failWith);
    return { close: async () => {} };
  } } });
  await launchRenderBrowser({ importPlaywright: playwright(null) });
  assert.equal(seen.at(-1), "bundled");
  await launchRenderBrowser({ importPlaywright: playwright(null), chromePath: process.execPath });
  assert.equal(seen.at(-1), process.execPath);
  await assert.rejects(launchRenderBrowser({ importPlaywright: playwright("some other launch failure") }), /other launch failure/);
  process.env.WI_CHROME = process.execPath;
  await launchRenderBrowser({ importPlaywright: playwright(null) });
  assert.equal(seen.at(-1), process.execPath);
});
test("a measurement that never returns times out, and the browser is closed", async (t) => {
  const dir = fixture(t), fake = fakePlaywright();
  fake.page.evaluate = () => new Promise(() => {});
  await assert.rejects(deckFit(dir, {}, { ...fake, deadlineMs: 50 }), (e) => e.status === 504 && e.payload.error === "fit_timeout");
  assert.equal(fake.state.closed, 1);
});
test("POST deck fit uses the per-document server harness", async (t) => {
  const dir = fixture(t), fake = fakePlaywright();
  const svc = createServer({ dir, deckFitOptions: fake });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  const request = (body) => fetch(`http://localhost:${port}/api/deck/fit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const r = await request({});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  const bad = await request({ stated: "2" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_body", field: "stated" });
});

const { chromium } = await import("playwright");
// CI's acceptance job pins the runner's Chrome (WI_CHROME) and sets WI_REQUIRE_BROWSER, so a missing browser
// FAILS there instead of skipping; locally Playwright's own Chromium is used when installed.
const browserPath = process.env.WI_CHROME || (existsSync(chromium.executablePath()) ? chromium.executablePath() : null);
const requireBrowser = process.env.WI_REQUIRE_BROWSER === "1";
test("real Chromium measures fitting and overflowing slide sections", { skip: !browserPath && !requireBrowser && "no Chromium (set WI_CHROME)", timeout: 90_000 }, async (t) => {
  assert.ok(browserPath, "WI_REQUIRE_BROWSER is set but no browser was found");
  const dir = mkdtempSync(join(tmpdir(), "wi-fit-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The stated count rides on the deck root: a stored version keeps the body's content, not its attributes.
  initWorkspace(dir, `<main data-wi-kind="deck" data-stated-slides="2"><section data-wid="fits"><div style="height:100px;flex-shrink:0">Fits</div></section><section data-wid="over"><div style="height:1200px;width:2000px;flex-shrink:0">Overflows</div></section></main>`, { style: "ppt" });
  // Pin Playwright's installed Chromium instead of the optional system Chrome fallback.
  const result = await deckFit(dir, {}, { chromePath: browserPath });
  assert.equal(result.actual, 2);
  assert.equal(result.stated, 2);
  assert.equal(result.slides[0].overflow, false);
  assert.ok(result.slides[1].overflowPx > 2);
  assert.equal(result.ok, false);
});

test("real Chromium keeps an authored grid slide's layout while measuring it", { skip: !browserPath && !requireBrowser && "no Chromium (set WI_CHROME)", timeout: 90_000 }, async (t) => {
  assert.ok(browserPath, "WI_REQUIRE_BROWSER is set but no browser was found");
  const dir = mkdtempSync(join(tmpdir(), "wi-fit-grid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Three 400 px rows in one grid column overflow 1080 px; laid out as a flex row (the export's slide rule) they
  // would fit. An ordinary authored grid: the measurement keeps it.
  const rows = '<div style="height:400px">a</div><div style="height:400px">b</div><div style="height:400px">c</div>';
  initWorkspace(dir, `<main data-wi-kind="deck"><section data-wid="grid" style="display:grid;grid-template-columns:1fr">${rows}</section></main>`, { style: "ppt" });
  const result = await deckFit(dir, {}, { chromePath: browserPath });
  assert.equal(result.slides[0].overflow, true, JSON.stringify(result.slides));
});
