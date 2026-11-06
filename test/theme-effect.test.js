// theme-effect.test.js — a restyle is recorded only when it changes how the version looks (F8, e2e-1105).
//
// The defect: Slides → Style landed "Version N / Restyled the theme" on decks whose own CSS hard-codes every
// colour, so the slides rendered unchanged. The route now renders the head against its re-themed copy first.
//
// Part 1 pins the check (no browser): what the route writes and answers for each outcome.
// Part 2 renders for real in headless Chromium: whenever a restyle lands a version, that version's computed
// colours differ from its parent's; a deck that hard-codes its colours is refused instead. It skips where no
// browser can launch, and is REQUIRED in CI's acceptance job (WI_REQUIRE_BROWSER=1, a pinned Chrome).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { resolveThemeTokens } from "../src/service/theme-source.js";
import { launchRenderBrowser } from "../src/service/export.js";
import { isResponsive, themeEffect, ThemeCheckUnavailable, ThemeCheckUnverifiable } from "../src/service/theme-effect.js";
import { DEFAULT_THEME } from "../src/core/theme.js";

const PURPLE = resolveThemeTokens("midnight-purple");

// A deck as 0.17.0 drafted it (e2e-1105 run 6d92d5a5): every colour and font is a literal in its own CSS.
const HEX_DECK = `<!DOCTYPE html><html><head><style>
html,body{margin:0;padding:0;background:#10131a}
section.slide{box-sizing:border-box;width:1280px;height:720px;background:#171b26;color:#f2f4f8;font-family:Helvetica,Arial,sans-serif;padding:64px 80px}
h1{font-size:56px;color:#ffffff} p{font-size:28px;color:#e4e8f0}
.card{background:#0d1017;border-left:6px solid #5aa9ff;padding:18px 26px}
</style></head><body>
<section class="slide"><h1>What is tiny-math?</h1><p>A repository of math helpers.</p><div class="card"><p>sum, mean, clamp</p></div></section>
<section class="slide"><h1>Next</h1><p>Each function on empty input.</p></section>
</body></html>`;

// The same deck under the drafting contract: colours and fonts through the theme tokens, hex only as fallbacks.
const TOKEN_DECK = HEX_DECK
  .replace("background:#10131a", "background:var(--wi-bg, #10131a)")
  .replace("background:#171b26;color:#f2f4f8;font-family:Helvetica,Arial,sans-serif",
    "background:var(--wi-surface, #171b26);color:var(--wi-text, #f2f4f8);font-family:var(--wi-font-body, Helvetica)")
  .replace("h1{font-size:56px;color:#ffffff} p{font-size:28px;color:#e4e8f0}",
    "h1{font-size:56px;color:var(--wi-primary, #ffffff)} p{font-size:28px;color:var(--wi-text, #e4e8f0)}")
  .replace("background:#0d1017;border-left:6px solid #5aa9ff", "background:var(--wi-card-bg, #0d1017);border-left:6px solid var(--wi-accent, #5aa9ff)");

// A drafter that declared the tokens itself on :root anyway: the theme's `:root:root` block still wins.
const DECLARING_DECK = TOKEN_DECK.replace("<style>", "<style>:root{--wi-bg:#10131a;--wi-surface:#171b26;--wi-text:#f2f4f8;--wi-primary:#ffffff}");

// A drafted Document: its own CSS sets the page colours, but not the headings' — those wear the theme.
const DOC = `<!DOCTYPE html><html><head><style>html{background:#ffffff;color:#171717} body{margin:0;font-family:Georgia,serif}
h1{font-size:25pt}</style></head><body><main><h1>tiny-math explained</h1><p>Three helpers.</p></main></body></html>`;

function workspace(html, style = "ppt", opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wi-effect-"));
  initWorkspace(dir, html, { style, ...opts });
  return dir;
}

async function serve(dir, themeCheck, extra = {}) {
  const events = [];
  const svc = createServer({ dir, documentId: "doc", emit: (type, payload) => events.push({ type, payload }), ...(themeCheck ? { themeCheck } : {}), ...extra });
  const port = await svc.start(0);
  const put = (body) => fetch(`http://localhost:${port}/api/theme/learned`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { events, put, stop: () => svc.stop() };
}
const created = (events) => events.filter((e) => e.type === "wicked.interactive.version.created");

// ── Part 1: the route, with the check pinned ────────────────────────────────────────────────────────

test("a restyle that changes nothing visible writes nothing: no version, no learned file, no version.created", async () => {
  const dir = workspace(HEX_DECK);
  const seen = [];
  const { events, put, stop } = await serve(dir, async (before, after) => { seen.push({ before, after }); return { changed: false }; });
  try {
    const res = await put({ tokens: PURPLE, apply: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual({ written: body.written, version: body.version, unchanged: body.unchanged, reason: body.reason },
      { written: false, version: null, unchanged: true, reason: "no_visible_change" });
    assert.match(body.message, /drafted before themes/);
    assert.equal(loadManifest(dir).head, 0);
    assert.equal(created(events).length, 0);
    assert.ok(!existsSync(join(dir, "theme", "learned.theme.json")), "the learned theme was not written");
    // The check compared the head with its re-themed copy.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].before, readVersionHtml(dir, 0));
    assert.match(seen[0].after, /data-wi-theme="midnight-purple"/);
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("with no browser to check it, the restyle is a 503 that names the fix, and nothing is written", async () => {
  const dir = workspace(HEX_DECK);
  const { events, put, stop } = await serve(dir, async () => { throw new ThemeCheckUnavailable("no browser to render it"); });
  try {
    const res = await put({ tokens: PURPLE, apply: true });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "theme_check_unavailable");
    assert.equal(body.hint, "wicked-interactive doctor --install");
    assert.equal(loadManifest(dir).head, 0);
    assert.equal(created(events).length, 0);
    assert.ok(!existsSync(join(dir, "theme", "learned.theme.json")));
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a version the check can't render faithfully is a 422 unverifiable, and nothing is written", async () => {
  const dir = workspace(HEX_DECK);
  const { events, put, stop } = await serve(dir, async () => { throw new ThemeCheckUnverifiable("its styles load from https://cdn.example/x.css"); });
  try {
    const res = await put({ tokens: PURPLE, apply: true });
    // A non-2xx refusal, so every consumer's error path shows the reason (studio surfaces `error`).
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "theme_unverifiable");
    assert.match(body.error, /No version was made: .*cdn\.example/);
    assert.equal(loadManifest(dir).head, 0);
    assert.equal(created(events).length, 0);
    assert.ok(!existsSync(join(dir, "theme", "learned.theme.json")));
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("styles the offline render can't load make the check unverifiable before any browser starts", async () => {
  const dir = workspace(HEX_DECK);
  try {
    const launch = async () => { throw new Error("must not launch"); };
    const remote = HEX_DECK.replace("<style>", '<link rel="stylesheet" href="https://cdn.example/deck.css"><style>');
    await assert.rejects(themeEffect(remote, remote.replace("#10131a", "#000"), { dir, launch }), ThemeCheckUnverifiable);
    const missing = HEX_DECK.replace("<style>", "<style>@import url(gone.css);");
    await assert.rejects(themeEffect(missing, missing, { dir, launch }), ThemeCheckUnverifiable);
    // Any resource it shows, not only styles: a remote image could cover what the theme paints.
    const image = HEX_DECK.replace("</body>", '<img src="https://cdn.example/cover.png"></body>');
    await assert.rejects(themeEffect(image, image, { dir, launch }), ThemeCheckUnverifiable);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the check's deadline covers the browser launch, and a browser that lands late is still closed", async () => {
  const dir = workspace(HEX_DECK);
  try {
    let closed = 0;
    const launch = () => new Promise((r) => setTimeout(() => r({ close: async () => { closed++; } }), 150));
    await assert.rejects(themeEffect(HEX_DECK, HEX_DECK, { dir, launch, deadlineMs: 20 }), ThemeCheckUnavailable);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(closed, 1);
    // The sandbox stays on unless the operator opts out.
    let seen;
    await assert.rejects(themeEffect(HEX_DECK, HEX_DECK, { dir, launch: async (o) => { seen = o; throw new Error("no browser"); } }), ThemeCheckUnavailable);
    assert.equal(seen.sandbox, true);
    process.env.WI_RENDER_NO_SANDBOX = "1";
    try {
      await assert.rejects(themeEffect(HEX_DECK, HEX_DECK, { dir, launch: async (o) => { seen = o; throw new Error("no browser"); } }), ThemeCheckUnavailable);
      assert.equal(seen.sandbox, false);
    } finally { delete process.env.WI_RENDER_NO_SANDBOX; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a restyle waiting in the document queue past its deadline is answered 503 at once, and then does nothing", async () => {
  const dir = workspace(HEX_DECK);
  let calls = 0;
  // The first restyle's check holds the queue for 400 ms; each restyle's deadline is 100 ms from its arrival.
  const { events, put, stop } = await serve(dir, async () => { calls++; await new Promise((r) => setTimeout(r, 400)); return { changed: true }; }, { themeCheckMs: 100 });
  try {
    const first = put({ tokens: PURPLE, apply: true });
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    const second = await put({ tokens: resolveThemeTokens("warm-dark"), apply: true });
    assert.equal(second.status, 503);
    assert.ok(Date.now() - t0 < 300, "answered at its own deadline, not when the queue let it through");
    assert.equal((await second.json()).code, "theme_check_unavailable");
    // The first one ran past its own deadline too: answered 503, and its late result writes nothing.
    assert.equal((await first).status, 503);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(calls, 1, "the expired queued restyle never ran its check");
    assert.equal(loadManifest(dir).head, 0);
    assert.equal(created(events).length, 0);
    assert.ok(!existsSync(join(dir, "theme", "learned.theme.json")));
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a visible change lands one theme version; identical tokens and apply:false never call the check", async () => {
  const dir = workspace(TOKEN_DECK);
  let calls = 0;
  const { events, put, stop } = await serve(dir, async () => { calls++; return { changed: true }; });
  try {
    const first = await (await put({ tokens: PURPLE, apply: true })).json();
    assert.deepEqual({ written: first.written, version: first.version, kind: first.kind }, { written: true, version: 1, kind: "theme" });
    assert.equal(created(events).length, 1);
    const again = await (await put({ tokens: PURPLE, apply: true })).json();
    assert.deepEqual({ written: again.written, version: again.version, unchanged: again.unchanged }, { written: true, version: null, unchanged: true });
    const noApply = await (await put({ tokens: resolveThemeTokens("warm-dark") })).json();
    assert.equal(noApply.written, true);
    assert.equal(calls, 1);
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ── Part 2: the real render ──────────────────────────────────────────────────────────────────────────

let browserProblem = null;
// The same launch the check makes: Chromium's sandbox on unless the operator opted out.
try { await (await launchRenderBrowser({ sandbox: process.env.WI_RENDER_NO_SANDBOX !== "1" })).close(); }
catch (e) { browserProblem = String(e?.message ?? e).split("\n")[0]; }
if (browserProblem && process.env.WI_REQUIRE_BROWSER === "1") throw new Error(`WI_REQUIRE_BROWSER=1 but no browser launches: ${browserProblem}`);
const real = { skip: browserProblem ? `no browser: ${browserProblem}` : false };

/**
 * A version as a reader sees it, in an ordinary browser page (scripts on, nothing sealed): its pixels at a
 * desktop and a phone width (the oracle), and a few computed colours (to name the theme it wears).
 */
async function look(html) {
  const browser = await launchRenderBrowser();
  try {
    const shots = [];
    let colours = null;
    for (const viewport of [{ width: 1440, height: 700 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(html);
      // The whole page, as an explicit clip (a plain full-page capture of a page wider than a phone's viewport can fail
      // in headless Chrome: "Unable to capture screenshot").
      const { width, height } = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      shots.push((await page.screenshot({ fullPage: true, animations: "disabled", clip: { x: 0, y: 0, width, height: Math.min(height, 12000) } })).toString("base64"));
      colours ??= await page.evaluate(() => {
        const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
        const box = cs("section") ?? cs("main");
        return { body: cs("body").backgroundColor, box: box.backgroundColor, h1: cs("h1").color, p: cs("p").color };
      });
      await page.close();
    }
    return { shots, ...colours };
  } finally { await browser.close(); }
}

/** Restyle the head through the real route; then: a landed version looks different from its parent. */
async function restyle(html, style) {
  const dir = workspace(html, style);
  const { put, stop } = await serve(dir);
  try {
    const body = await (await put({ tokens: PURPLE, apply: true })).json();
    const parent = await look(readVersionHtml(dir, 0));
    const after = body.version === null ? null : await look(readVersionHtml(dir, body.version));
    if (after !== null) assert.notDeepEqual(after.shots, parent.shots, "a restyled version must render differently from the one it restyled");
    return { body, parent, after };
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
}

test("F8: a deck that hard-codes its colours is refused, never recorded as a restyle", real, async () => {
  const { body } = await restyle(HEX_DECK, "ppt");
  assert.equal(body.version, null);
  assert.equal(body.reason, "no_visible_change");
});

test("F8: a deck drafted on the theme tokens restyles, and the new version wears the new theme", real, async () => {
  const { body, after } = await restyle(TOKEN_DECK, "ppt");
  assert.equal(body.kind, "theme");
  assert.equal(after.box, "rgb(19, 9, 29)");   // midnight-purple surface #13091D
  assert.equal(after.h1, "rgb(161, 0, 255)");  // primary #A100FF
  assert.equal(after.p, "rgb(255, 255, 255)"); // text_primary #FFFFFF
});

test("F8: a deck that declares the tokens itself on :root still wears the theme it is given", real, async () => {
  const { body, after } = await restyle(DECLARING_DECK, "ppt");
  assert.equal(body.kind, "theme");
  assert.equal(after.box, "rgb(19, 9, 29)");
});

test("F8: a drafted Document whose headings take the theme still restyles (the base layer shows)", real, async () => {
  const { body, after } = await restyle(DOC, "doc");
  assert.equal(body.kind, "theme");
  assert.equal(after.h1, "rgb(161, 0, 255)");
});

// ── codex r1 (deck-style-pptx): the comparison is the reader's: pixels, not computed styles ─────────

test("paint nobody can see is not a change: a token used only under opacity:0 or a clip is refused", real, async () => {
  const hidden = HEX_DECK.replace("</body>", '<div style="opacity:0"><p style="color:var(--wi-primary)">invisible</p></div>' +
    '<div style="height:0;overflow:hidden"><p style="color:var(--wi-primary)">clipped</p></div></body>');
  const { body } = await restyle(hidden, "ppt");
  assert.equal(body.reason, "no_visible_change");
});

test("a font token that resolves to the same fallback on both sides is not a change", real, async () => {
  const fonts = (f) => ({ ...DEFAULT_THEME, name: f, fonts: { heading: f, body: f, mono: f } });
  const html = HEX_DECK.replace("font-family:Helvetica,Arial,sans-serif", "font-family:var(--wi-font-body), sans-serif");
  const dir = workspace(html, "ppt", { tokens: fonts("No Such Font A") });
  const { put, stop } = await serve(dir);
  try {
    const body = await (await put({ tokens: fonts("No Such Font B"), apply: true })).json();
    assert.equal(body.reason, "no_visible_change");
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("paint a property snapshot can't see is a change: an SVG gradient stop, a form control's text", real, async () => {
  for (const extra of [
    '<svg width="200" height="40"><defs><linearGradient id="g"><stop offset="0" style="stop-color:var(--wi-primary)"/>' +
      '<stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="200" height="40" fill="url(#g)"/></svg>',
    '<input value="Visible text" style="color:var(--wi-primary);background:#fff;border:1px solid #000">',
  ]) {
    const { body } = await restyle(HEX_DECK.replace("</body>", `${extra}</body>`), "ppt");
    assert.equal(body.kind, "theme", extra);
  }
});

test("a token used only at a phone width is still a visible change", real, async () => {
  const phone = HEX_DECK.replace("</style>", "@media (max-width: 600px){h1{color:var(--wi-primary)}}</style>");
  const { body } = await restyle(phone, "ppt");
  assert.equal(body.kind, "theme");
});

test("the theme check's launch keeps Chromium's sandbox on; the export's launch keeps its own flags", async () => {
  const seen = [];
  const importPlaywright = async () => ({ chromium: { launch: async (o) => { seen.push(o); return { close: async () => {} }; } } });
  await launchRenderBrowser({ importPlaywright, sandbox: true, chromePath: process.execPath });
  assert.equal(seen[0].chromiumSandbox, true);
  assert.ok(!seen[0].args.includes("--no-sandbox"));
  await launchRenderBrowser({ importPlaywright, chromePath: process.execPath });
  assert.ok(seen[1].args.includes("--no-sandbox"));
  assert.equal(seen[1].chromiumSandbox, undefined);
});

test("at the deadline a render in flight is ended (its browser closed); a caller waiting for it times out on its own deadline", async () => {
  const dir = workspace(HEX_DECK);
  try {
    const browsers = [];
    // A browser whose page never finishes loading: the render stalls until the browser is closed.
    const launch = async () => {
      const b = { open: true, close: async () => { b.open = false; } };
      b.newContext = async () => ({
        route: async () => {}, close: async () => {},
        newPage: async () => ({ setContent: () => new Promise((_, reject) => { const t = setInterval(() => { if (!b.open) { clearInterval(t); reject(new Error("closed")); } }, 5); }) }),
      });
      browsers.push(b);
      return b;
    };
    const first = themeEffect(HEX_DECK, HEX_DECK.replace("#10131a", "#000"), { dir, launch, deadlineMs: 600 });
    const t0 = Date.now();
    const second = themeEffect(HEX_DECK, HEX_DECK.replace("#10131a", "#111"), { dir, launch, deadlineMs: 60 });
    await assert.rejects(second, ThemeCheckUnavailable);
    const waited = Date.now() - t0;
    assert.ok(waited < 400, `the waiting caller timed out at its own deadline, not the first render's (${waited} ms)`);
    assert.equal(browsers.length, 1, "the expired caller never launched a browser");
    assert.equal(browsers[0].open, true, "the first render is still running");
    await assert.rejects(first, ThemeCheckUnavailable);
    assert.equal(browsers[0].open, false, "the stalled render's browser is closed at its deadline");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(browsers.length, 1, "expired queued work still never launches");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the next render starts only once the last one's browser has finished closing", async () => {
  const dir = workspace(HEX_DECK);
  try {
    const log = [];
    const launch = async () => {
      log.push("launch");
      return {
        newContext: async () => { throw new Error("context failed"); },
        close: () => new Promise((r) => setTimeout(() => { log.push("closed"); r(); }, 120)),
      };
    };
    const one = themeEffect(HEX_DECK, HEX_DECK.replace("#10131a", "#000"), { dir, launch });
    const two = themeEffect(HEX_DECK, HEX_DECK.replace("#10131a", "#111"), { dir, launch });
    await assert.rejects(one, ThemeCheckUnavailable);
    await assert.rejects(two, ThemeCheckUnavailable);
    await new Promise((r) => setTimeout(r, 200)); // the second browser's close, after its caller has its answer
    assert.deepEqual(log, ["launch", "closed", "launch", "closed"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the tablet and phone widths are checked whenever the version can change with width", () => {
  for (const html of ["<style>@media (max-width:600px){h1{color:red}}</style>", "<style>@container (min-width:40em){p{color:red}}</style>",
    '<link rel="stylesheet" media="(max-width:600px)" href="data:text/css,h1{}">', '<style media="print">h1{color:red}</style>']) {
    assert.equal(isResponsive(html), true, html);
  }
  assert.equal(isResponsive("<style>h1{color:red}</style><p>media query free</p>"), false);
});

test("a long page is compared to its end: a change below the first band lands; invisible paint there does not", real, async () => {
  const tall = (extra) => HEX_DECK.replace("</body>", `<div style="height:5200px"></div>${extra}</body>`);
  assert.equal((await restyle(tall('<p style="color:var(--wi-primary)">late</p>'), "ppt")).body.kind, "theme");
  assert.equal((await restyle(tall('<p style="color:var(--wi-primary);opacity:0">late</p>'), "ppt")).body.reason, "no_visible_change");
});

test("an endlessly animated SVG is paused at its start, so it renders the same twice and is judged", real, async () => {
  const dir = workspace(HEX_DECK);
  try {
    const anim = HEX_DECK.replace("</body>", '<svg width="100" height="100"><rect width="100" height="100" fill="red">' +
      '<animate attributeName="x" values="0;50;0" dur="0.3s" repeatCount="indefinite"/></rect></svg></body>');
    // Paused at its start, it renders the same both times: judged, and nothing visible changed.
    assert.deepEqual(await themeEffect(anim, anim.replace("#10131a", "#10131a "), { dir }), { changed: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a request the render had to refuse makes the check unverifiable (an iframe's remote image)", real, async () => {
  const dir = workspace(HEX_DECK);
  try {
    const framed = HEX_DECK.replace("</body>", '<iframe srcdoc="&lt;img src=&quot;https://cdn.example/cover.png&quot;&gt;"></iframe></body>');
    await assert.rejects(themeEffect(framed, framed.replace("#10131a", "#000"), { dir }), ThemeCheckUnverifiable);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
