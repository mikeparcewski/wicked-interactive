// handlers.test.js — materialization layer (ADR-0019), driven directly with a spy emit.
// No bus, no server — just (dir, payload, ctx) → workspace mutations + emitted facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import {
  materializeFeedback, materializeEdit, materializeDraft, materializeDemo,
  materializeSourceAttached, materializeSourceUpdated, appendConversation,
  materializeThemeRequested, themeArtifactPath,
} from "../src/service/handlers.js";

function ws(html = "<h1>Q2 Results</h1><p>body</p>") {
  const dir = mkdtempSync(join(tmpdir(), "wi-handlers-"));
  initWorkspace(dir, html);
  return dir;
}
function spyCtx(documentId = "t1") {
  const events = [];
  return { documentId, events, emit: (type, payload) => events.push({ type, payload }) };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test("materializeFeedback applies a deterministic edit and emits version.created + feedback.processed", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const out = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
    }, ctx);
    assert.equal(out.version, 1);
    assert.equal(loadManifest(dir).head, 1, "manifest advanced to v1");
    const html = readFileSync(join(dir, "_v1.html"), "utf-8");
    assert.match(html, /Q3 Results/, "deterministic edit applied");
    const types = ctx.events.map((e) => e.type);
    assert.deepEqual(types, ["wicked.interactive.version.created", "wicked.interactive.feedback.processed"]);
    const vc = ctx.events[0].payload;
    assert.equal(vc.version, 1); assert.equal(vc.parent, 0); assert.equal(vc.kind, "deterministic");
    const fp = ctx.events[1].payload;
    assert.equal(fp.awaiting_structural, 0);
    assert.deepEqual(fp.structural_items, []);
  } finally { cleanup(dir); }
});

test("materializeFeedback surfaces structural items inline (no request file) and announces NO phantom version (F-RECON-005)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "make it punchier" }],
    }, ctx);
    // A structural-only batch changes nothing yet: no version.created may fire (the thread said
    // "v3 landed" for a byte-identical copy before), only the handoff.
    assert.deepEqual(ctx.events.map((e) => e.type), ["wicked.interactive.feedback.processed"]);
    const fp = ctx.events.find((e) => e.type === "wicked.interactive.feedback.processed").payload;
    assert.equal(fp.awaiting_structural, 1);
    assert.equal(fp.version, 1, "the handoff id is the batch's reserved number");
    assert.equal(fp.landed, false);
    assert.equal(fp.unchanged, true);
    assert.equal(fp.base_version, 0);
    assert.equal(fp.feedback_file, "_v1.md");
    assert.equal(fp.structural_items[0].selector, "slide-0-heading-1");
    assert.equal(fp.structural_items[0].instruction, "make it punchier");
    assert.match(fp.structural_items[0].fragment, /data-wid="slide-0-heading-1"/, "current fragment extracted");
    assert.ok(!existsSync(join(dir, "requests", "_v1.request.json")), "NO request file written (event-native)");
    assert.ok(!existsSync(join(dir, "_v1.html")), "nothing landed");
    assert.equal(loadManifest(dir).head, 0);
  } finally { cleanup(dir); }
});

test("materializeEdit lands the agent's structural result as a follow-on version", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // First, a feedback that defers a structural item -> v1 partial.
    const fb = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }],
    }, ctx);
    const item = fb.structural_items[0];
    ctx.events.length = 0;
    // Agent returns an edited fragment that PRESERVES the data-wid (INV-2).
    const edited = item.fragment.replace(/Q2 Results/, "Q2 — Crushed It");
    const out = await materializeEdit(dir, { version: fb.version, results: [{ selector: item.selector, fragment: edited }] }, ctx);
    // The structural-only handoff landed nothing (F-RECON-005), so the EDIT is v1, chained to v0.
    assert.equal(out.parent, 0);
    assert.equal(out.version, 1);
    assert.equal(loadManifest(dir).head, 1);
    const vc = ctx.events.find((e) => e.type === "wicked.interactive.version.created").payload;
    assert.equal(vc.kind, "structural");
    assert.equal(vc.version, 1); assert.equal(vc.parent, 0);
    assert.match(readFileSync(join(dir, "_v1.html"), "utf-8"), /Crushed It/);
  } finally { cleanup(dir); }
});

test("materializeDraft lands a generated draft from inline html", async () => {
  const dir = ws("<section><h1>Building…</h1></section>");
  const ctx = spyCtx();
  try {
    const out = await materializeDraft(dir, { html: "<section><h1>Investor Update</h1><p>Real numbers.</p></section>" }, ctx);
    assert.equal(out.version, 1);
    const html = readFileSync(join(dir, "_v1.html"), "utf-8");
    assert.match(html, /Investor Update/);
    assert.match(html, /data-wid=/, "fresh anchors assigned");
    assert.equal(ctx.events.find((e) => e.type === "wicked.interactive.version.created").payload.kind, "generated");
  } finally { cleanup(dir); }
});

test("materializeDraft reads html_path when html is absent (big-payload path, D5)", async () => {
  const dir = ws("<section><h1>Building…</h1></section>");
  const ctx = spyCtx();
  try {
    const htmlPath = join(dir, "draft.html");
    writeFileSync(htmlPath, "<section><h1>From Disk</h1></section>");
    const out = await materializeDraft(dir, { html_path: htmlPath }, ctx);
    assert.equal(out.version, 1);
    assert.match(readFileSync(join(dir, "_v1.html"), "utf-8"), /From Disk/);
  } finally { cleanup(dir); }
});

test("a learned theme in the workspace is auto-applied at version-creation (the apply leg)", async () => {
  const learned = {
    name: "test-learned",
    colors: { background: "#101015", surface: "#181820", primary: "#abcdef", secondary: "#445566",
      accent: "#ffaa00", text_primary: "#ffffff", text_secondary: "#cccccc", text_muted: "#888888", border: "#333333" },
    fonts: { heading: "Georgia", body: "Georgia", mono: "Courier" },
    sizes: { title: "48px", heading: "36px", body: "18px" },
    spacing: {}, card: { background: "#181818", border_radius: "12px", padding: "24px", shadow: "none" },
  };
  // WITH a learned theme: the landed draft must carry the learned tokens (not the default).
  const dir = ws("<section><h1>Building…</h1></section>");
  try {
    mkdirSync(join(dir, "theme"), { recursive: true });
    writeFileSync(join(dir, "theme", "learned.theme.json"), JSON.stringify(learned));
    await materializeDraft(dir, { html: "<section><h1>Investor Update</h1></section>" }, spyCtx());
    const html = readFileSync(join(dir, "_v1.html"), "utf-8");
    assert.match(html, /data-wi-theme="test-learned"/, "learned theme block injected");
    assert.match(html, /--wi-primary:#abcdef/, "learned primary actually applied");
  } finally { cleanup(dir); }

  // CONTROL: no learned theme -> default theme, learned color absent (proves the learned file caused it).
  const dir2 = ws("<section><h1>Building…</h1></section>");
  try {
    await materializeDraft(dir2, { html: "<section><h1>Investor Update</h1></section>" }, spyCtx());
    const html2 = readFileSync(join(dir2, "_v1.html"), "utf-8");
    assert.doesNotMatch(html2, /#abcdef/, "no learned color without a learned theme");
    assert.match(html2, /data-wi-theme="corporate-light"/, "default theme when none learned");
  } finally { cleanup(dir2); }
});

test("source attach + update round-trips through sources.json", () => {
  const dir = ws();
  try {
    materializeSourceAttached(dir, { added: [{ path: "/tmp/a.txt", note: "use" }, { path: "/tmp/a.txt" }] });
    let saved = JSON.parse(readFileSync(join(dir, "requests", "sources.json"), "utf-8"));
    assert.equal(saved.sources.length, 1, "duplicate path collapsed");
    assert.equal(saved.sources[0].status, "pending");
    materializeSourceUpdated(dir, { path: "/tmp/a.txt", status: "indexed" });
    saved = JSON.parse(readFileSync(join(dir, "requests", "sources.json"), "utf-8"));
    assert.equal(saved.sources[0].status, "indexed");
    assert.ok(saved.sources[0].indexed_at);
  } finally { cleanup(dir); }
});

test("materializeThemeRequested grabs the URL and emits theme.learned with render_path", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // Inject a fake grab so no real Chrome/network is needed; assert it got the live url + a
    // workspace path under theme/, and that it wrote a PDF there.
    let grabbedUrl = null, grabbedOut = null;
    const fakeGrab = (url, out) => {
      grabbedUrl = url;
      grabbedOut = out;
      writeFileSync(out, "%PDF-1.4 fake");
      return { path: out };
    };
    const out = await materializeThemeRequested(dir, { url: "https://stripe.com" }, ctx, { grab: fakeGrab });
    assert.equal(grabbedUrl, "https://stripe.com");
    assert.match(grabbedOut, /[\\/]theme[\\/]learned_\d+\.pdf$/, "renders into the per-doc theme/ dir");
    assert.ok(existsSync(grabbedOut), "the PDF artifact exists");
    assert.equal(out.render_path, grabbedOut);
    const learned = ctx.events.find((e) => e.type === "wicked.interactive.theme.learned");
    assert.ok(learned, "emitted wicked.interactive.theme.learned");
    assert.equal(learned.payload.url, "https://stripe.com");
    assert.equal(learned.payload.render_path, grabbedOut);
    assert.equal(learned.payload.format, "pdf");
    // A working status is posted before the grab (progress), and no error status.
    assert.ok(ctx.events.some((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "working"));
    assert.ok(!ctx.events.some((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "error"));
  } finally { cleanup(dir); }
});

test("materializeThemeRequested learns from a LOCAL file (no grab) — emits theme.learned with the path (ADR-0023)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // A local PDF the user pointed at: the agent reads it in place, the service must NOT grab.
    const pdf = join(dir, "brand.pdf");
    writeFileSync(pdf, "%PDF-1.4 fake");
    let grabCalled = false;
    const out = await materializeThemeRequested(dir, { path: pdf }, ctx, { grab: () => { grabCalled = true; return { path: pdf }; } });
    assert.equal(grabCalled, false, "must not invoke the URL grab for a local file");
    assert.equal(out.render_path, pdf);
    assert.equal(out.format, "pdf");
    const learned = ctx.events.find((e) => e.type === "wicked.interactive.theme.learned");
    assert.ok(learned, "emitted wicked.interactive.theme.learned");
    assert.equal(learned.payload.render_path, pdf);
    assert.equal(learned.payload.format, "pdf");
    assert.ok(!ctx.events.some((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "error"));
  } finally { cleanup(dir); }
});

test("materializeThemeRequested classifies an image file as format:image", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const png = join(dir, "shot.png");
    writeFileSync(png, "\x89PNG fake");
    const out = await materializeThemeRequested(dir, { path: png }, ctx, { grab: () => { throw new Error("should not grab"); } });
    assert.equal(out.format, "image");
    assert.equal(out.render_path, png);
  } finally { cleanup(dir); }
});

test("materializeThemeRequested rejects a missing file with an error status (no throw)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const out = await materializeThemeRequested(dir, { path: join(dir, "nope.pdf") }, ctx, { grab: () => ({}) });
    assert.ok(out.error, "returns an error, does not throw");
    assert.ok(ctx.events.some((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "error"));
    assert.ok(!ctx.events.some((e) => e.type === "wicked.interactive.theme.learned"));
  } finally { cleanup(dir); }
});

test("materializeThemeRequested surfaces an error status (not a throw) on a bad URL", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // No grab should run for an invalid URL; a clean error status is posted instead of throwing.
    let calls = 0;
    const out = await materializeThemeRequested(dir, { url: "ftp://nope" }, ctx, { grab: () => { calls++; } });
    assert.equal(calls, 0, "grab never invoked for a non-http(s) url");
    assert.ok(out.error, "returns an error summary rather than throwing into the loop");
    const err = ctx.events.find((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "error");
    assert.ok(err, "emitted an error status the UI/agent can surface");
    assert.ok(!ctx.events.some((e) => e.type === "wicked.interactive.theme.learned"), "no theme.learned on failure");
  } finally { cleanup(dir); }
});

test("themeArtifactPath builds a stable per-doc theme/ pdf path", () => {
  const dir = ws();
  try {
    const p = themeArtifactPath(dir, 1234);
    assert.match(p, /[\\/]theme[\\/]learned_1234\.pdf$/);
    assert.ok(p.startsWith(dir), "stays inside the doc workspace");
  } finally { cleanup(dir); }
});

test("appendConversation persists transcript lines", () => {
  const dir = ws();
  try {
    appendConversation(dir, { role: "user", text: "make it premium" });
    appendConversation(dir, { role: "agent", text: "on it", state: "processing" });
    const lines = readFileSync(join(dir, "conversation.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].role, "user");
    assert.equal(lines[1].state, "processing");
  } finally { cleanup(dir); }
});


// ── materializeDemo: typed, terminal, never retried (F-RECON-012 / F-RECON-014) ────────────

function demoWs() {
  const dir = mkdtempSync(join(tmpdir(), "wi-handlers-demo-"));
  initWorkspace(dir, "<section><h1>Learning…</h1></section>", { kind: "demo" });
  return dir;
}
const okStatus = { ok: true, browser: "chromium-headless-shell", missing: [], components: [] };
const missingStatus = {
  ok: false, browser: "chromium-headless-shell", missing: ["chromium-headless-shell", "ffmpeg"], components: [],
  playwright_version: "1.62.1", install_command: "node cli install chromium-headless-shell", remedy: "wicked-interactive doctor --install",
  browsers_path: null, message: "the recorder's browser is not installed — run `wicked-interactive doctor --install`, then Re-record.",
};
function demoCtx(recorder = {}) {
  const ctx = spyCtx("demo-1");
  ctx.states = [];
  ctx.recorder = { onState: (st) => ctx.states.push(st.state), ...recorder };
  return ctx;
}

test("materializeDemo: missing browser + auto-install off → ONE typed error (status.posted + error.raised), resolves (no retry), recorder never launched", async () => {
  const dir = demoWs();
  const ctx = demoCtx({ status: async () => missingStatus, autoInstall: false });
  let recorded = 0;
  try {
    const out = await materializeDemo(dir, {}, ctx, { record: async () => { recorded += 1; } });
    assert.equal(recorded, 0, "no launch attempt against a missing browser");
    assert.ok(out.error, "resolves with the typed error instead of throwing into the command loop");
    assert.equal(out.error.code, "recorder_browser_missing");
    assert.equal(out.error.retryable, false);
    const types = ctx.events.map((e) => e.type);
    assert.deepEqual(types, ["wicked.interactive.status.posted", "wicked.interactive.error.raised"]);
    const st = ctx.events[0].payload;
    assert.equal(st.state, "error");
    assert.equal(st.code, "recorder_browser_missing");
    assert.equal(st.source, "recorder");
    assert.equal(st.retryable, false);
    assert.equal(st.remedy, "wicked-interactive doctor --install");
    assert.deepEqual(st.missing, ["chromium-headless-shell", "ffmpeg"]);
    assert.match(st.message, /^Recording failed: the recorder's browser is not installed/);
    assert.doesNotMatch(st.message, /[╔║╚]/);
    const er = ctx.events[1].payload;
    assert.equal(er.source, "recorder");
    assert.equal(er.error, "recorder_browser_missing");
    assert.equal(er.context.code, "recorder_browser_missing");
    assert.deepEqual(ctx.states, ["preflight", "failed"]);
    assert.equal(loadManifest(dir).head, 0, "no version landed");
  } finally { cleanup(dir); }
});

test("materializeDemo: missing browser + auto-install on → provisions (narrated), then records and lands the storyboard", async () => {
  const dir = demoWs();
  let present = false;
  let installed = null;
  const ctx = demoCtx({
    status: async () => (present ? okStatus : missingStatus),
    install: async ({ browser, onProgress }) => { installed = browser; onProgress({ phase: "downloading", percent: 100, size: "95 MiB" }); present = true; },
    autoInstall: true,
  });
  try {
    const out = await materializeDemo(dir, {}, ctx, {
      record: async (_dir, opts) => { opts.onStep({ index: 1, label: "Land" }); return { version: 1, parent: 0, video: "_v1.webm", steps: [{ label: "Land", at: 0 }] }; },
    });
    assert.equal(installed, "chromium-headless-shell");
    assert.equal(out.version, 1);
    const types = ctx.events.map((e) => e.type);
    assert.equal(types.at(-1), "wicked.interactive.version.created");
    const working = ctx.events.filter((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "working").map((e) => e.payload.message);
    assert.ok(working.some((m) => /Installing the recorder's browser/.test(m)), JSON.stringify(working));
    assert.ok(working.some((m) => /100%/.test(m)), "download progress narrated");
    assert.ok(working.some((m) => /Step 1: Land/.test(m)));
    assert.ok(!ctx.events.some((e) => e.payload.state === "error"));
    assert.deepEqual(ctx.states, ["preflight", "installing", "installing", "recording", "recording", "recorded"]);
  } finally { cleanup(dir); }
});

test("materializeDemo: a failing step → recording_step_failed naming the step; a launch failure → recorder_launch_failed; neither throws", async () => {
  const dir = demoWs();
  const ctx = demoCtx({ status: async () => okStatus });
  try {
    const stepErr = new Error("locator.click: Timeout 30000ms exceeded.");
    stepErr.recorderStep = { index: 2, label: "Open the scope" };
    let out = await materializeDemo(dir, {}, ctx, { record: async () => { throw stepErr; } });
    assert.equal(out.error.code, "recording_step_failed");
    assert.deepEqual(out.error.step, { index: 2, label: "Open the scope" });
    assert.match(ctx.events[0].payload.message, /step 2 \(Open the scope\)/);
    assert.equal(ctx.events[0].payload.retryable, false);
    ctx.events.length = 0;
    out = await materializeDemo(dir, {}, ctx, { record: async () => { throw new Error("browserType.launch: Failed to launch: spawn EACCES"); } });
    assert.equal(out.error.code, "recorder_launch_failed");
    // A missing-executable error thrown by the launch itself (preflight raced an uninstall) is
    // still classified, with Playwright's own path and no ASCII box.
    ctx.events.length = 0;
    out = await materializeDemo(dir, {}, ctx, { record: async () => { throw new Error("browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1/chrome-headless-shell\n╔══╗\n║ Looks like Playwright was just installed ║\n╚══╝"); } });
    assert.equal(out.error.code, "recorder_browser_missing");
    assert.equal(out.error.executable_path, "/x/chromium_headless_shell-1/chrome-headless-shell");
    assert.doesNotMatch(ctx.events[0].payload.message, /[╔║╚]/);
  } finally { cleanup(dir); }
});

test("materializeDemo: no spec authored yet → recording_spec_missing (typed, terminal) via the real recordDemo", async () => {
  const dir = demoWs();
  const ctx = demoCtx({ status: async () => okStatus });
  try {
    const out = await materializeDemo(dir, {}, ctx);   // real recordDemo: refuses before touching Playwright
    assert.equal(out.error.code, "recording_spec_missing");
    assert.equal(ctx.events[0].payload.code, "recording_spec_missing");
    assert.match(ctx.events[0].payload.remedy, /spec run/);
  } finally { cleanup(dir); }
});

test("materializeDemo: an install failure is typed recorder_browser_install_failed with the cause", async () => {
  const dir = demoWs();
  const ctx = demoCtx({ status: async () => missingStatus, install: async () => { throw new Error("ENOTFOUND cdn.playwright.dev"); }, autoInstall: true });
  try {
    const out = await materializeDemo(dir, {}, ctx, { record: async () => { throw new Error("must not run"); } });
    assert.equal(out.error.code, "recorder_browser_install_failed");
    assert.match(out.error.cause, /ENOTFOUND/);
    assert.equal(ctx.events.filter((e) => e.payload.state === "error").length, 1, "exactly one error line");
    assert.deepEqual(ctx.states, ["preflight", "installing", "failed"]);
  } finally { cleanup(dir); }
});
