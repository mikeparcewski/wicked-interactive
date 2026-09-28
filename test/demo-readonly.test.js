// demo-readonly.test.js — the recorder is READ-ONLY and can DRY-RUN a spec (wicked-crew#565, #500;
// interactive#235). A fake Playwright stands in for the browser (the unit suite never launches
// one): its context records the route handler the recorder installs, and page actions push their
// requests through it, so the test sees exactly which requests were continued and which aborted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordDemo } from "../src/service/demo.js";
import { classifyRecorderError, recorderErrorPayload, RecorderError } from "../src/service/recorder-preflight.js";
import { materializeDemo } from "../src/service/handlers.js";
import { initWorkspace } from "../src/service/workspace.js";

const TARGET = "http://app.test";

/** A fake `playwright` module. `actions` maps a selector to the requests its click sends. */
function fakePlaywright({ actions = {}, failWaitForUrl = false } = {}) {
  const seen = { contextOpts: null, continued: [], aborted: [], tracing: 0 };
  let handler = null;
  const send = async (method, url) => {
    let outcome = "unrouted";
    await handler({
      request: () => ({ method: () => method, url: () => url }),
      continue: async () => { outcome = "continued"; seen.continued.push(`${method} ${url}`); },
      abort: async () => { outcome = "aborted"; seen.aborted.push(`${method} ${url}`); },
    });
    return outcome;
  };
  const page = {
    goto: async (url) => { await send("GET", url); },
    click: async (sel) => { for (const [m, u] of actions[sel] ?? []) await send(m, u); },
    waitForURL: async (pattern) => { if (failWaitForUrl) throw new Error(`page.waitForURL: Timeout 30000ms exceeded waiting for ${pattern}`); },
    evaluate: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => {},
    video: () => null,
    close: async () => {},
  };
  const context = {
    route: async (_pattern, fn) => { handler = fn; },
    tracing: { start: async () => { seen.tracing += 1; }, stop: async () => {} },
    newPage: async () => page,
    close: async () => {},
  };
  const chromium = { launch: async () => ({ newContext: async (opts) => { seen.contextOpts = opts; return context; }, close: async () => {} }) };
  return { importPlaywright: async () => ({ chromium }), seen };
}

/** A workspace dir holding `demo.spec.mjs` with the given run() body (and optional extra meta). */
function specDir(body, metaExtra = "") {
  const dir = mkdtempSync(join(tmpdir(), "wi-demo-ro-"));
  writeFileSync(join(dir, "demo.spec.mjs"),
    `export const meta = { url: "${TARGET}/", title: "Tour"${metaExtra} };\n` +
    `export async function run({ page, step, meta }) {\n${body}\n}\n`);
  return dir;
}

const LAUNCH_AND_APPROVE = `
  await page.goto(meta.url);
  await step("Open the dashboard", async () => { await page.click("#nav"); });
  await step("Launch a bug run", async () => { await page.click("#launch"); await page.waitForURL("**/runs/**"); });
  await step("Approve the gate", async () => { await page.click("#approve"); });
`;
const ACTIONS = {
  "#nav": [["GET", `${TARGET}/api/v1/runs`]],
  "#launch": [["POST", `${TARGET}/api/v1/runs`]],
  "#approve": [["POST", `${TARGET}/api/v1/runs/r1/gates/g1/decision`]],
};

test("dry run of a read-only spec passes: every step runs, nothing is recorded, no version lands", async () => {
  const dir = specDir(`
    await page.goto(meta.url);
    await step("Open the dashboard", async () => { await page.click("#nav"); });
    await step("Open a run", async () => { await page.click("#nav"); await page.waitForURL("**/runs/**"); });
  `);
  const pw = fakePlaywright({ actions: ACTIONS });
  const out = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.steps.map((s) => s.label), ["Open the dashboard", "Open a run"]);
  assert.equal(pw.seen.contextOpts.recordVideo, undefined, "a dry run records no video");
  assert.equal(pw.seen.contextOpts.serviceWorkers, "block");
  assert.equal(pw.seen.tracing, 0, "a dry run starts no trace");
  assert.equal(existsSync(join(dir, "recordings")), false, "a dry run writes no recordings");
  assert.equal(existsSync(join(dir, "versions.json")), false, "a dry run lands no version");
  assert.deepEqual(pw.seen.aborted, []);
});

test("a spec that launches a run and approves its gate fails its dry run at the launch step: side_effect_blocked, the POST never left the browser", async () => {
  const dir = specDir(LAUNCH_AND_APPROVE);
  const pw = fakePlaywright({ actions: ACTIONS, failWaitForUrl: true });
  const err = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright }).then(() => null, (e) => e);
  assert.ok(err instanceof RecorderError, String(err));
  assert.equal(err.code, "side_effect_blocked");
  assert.deepEqual(err.step, { index: 2, label: "Launch a bug run" });
  assert.deepEqual(err.request, { method: "POST", url: `${TARGET}/api/v1/runs` });
  assert.equal(err.retryable, false);
  assert.match(err.message, /step 2 \(Launch a bug run\) sent POST http:\/\/app\.test\/api\/v1\/runs/);
  // The launch POST was aborted; the approve step never ran.
  assert.deepEqual(pw.seen.aborted, [`POST ${TARGET}/api/v1/runs`]);
  assert.ok(!pw.seen.continued.some((r) => r.startsWith("POST")), "no write was ever continued");
  const wire = recorderErrorPayload(err);
  assert.equal(wire.code, "side_effect_blocked");
  assert.deepEqual(wire.request, { method: "POST", url: `${TARGET}/api/v1/runs` });
  assert.deepEqual(wire.step, { index: 2, label: "Launch a bug run" });
});

test("a write blocked in a step whose own action then succeeds still fails that step", async () => {
  const dir = specDir(LAUNCH_AND_APPROVE);
  const pw = fakePlaywright({ actions: ACTIONS });
  const err = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright }).then(() => null, (e) => e);
  assert.equal(err?.code, "side_effect_blocked");
  assert.equal(err.step.index, 2);
});

test("the RECORDING is read-only too: a blocked write fails it typed and lands no version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-demo-ro-rec-"));
  initWorkspace(dir, "<h1>Learning…</h1>", { kind: "demo" });
  const src = specDir(LAUNCH_AND_APPROVE);
  writeFileSync(join(dir, "demo.spec.mjs"), readFileSync(join(src, "demo.spec.mjs")));
  const pw = fakePlaywright({ actions: ACTIONS });
  const emitted = [];
  const ctx = { documentId: "tour", emit: (type, payload) => emitted.push({ type, payload }) };
  const out = await materializeDemo(dir, {}, ctx, {
    record: (d, o) => recordDemo(d, { ...o, importPlaywright: pw.importPlaywright }),
    ensureBrowser: async () => ({ ok: true }),
  });
  assert.equal(out.error.code, "side_effect_blocked");
  const status = emitted.find((e) => e.type === "wicked.interactive.status.posted" && e.payload.state === "error");
  assert.equal(status.payload.code, "side_effect_blocked");
  assert.deepEqual(status.payload.request, { method: "POST", url: `${TARGET}/api/v1/runs` });
  assert.deepEqual(status.payload.step, { index: 2, label: "Launch a bug run" });
  assert.match(status.payload.remedy, /step 2 \(Launch a bug run\)/);
  assert.ok(!emitted.some((e) => e.type === "wicked.interactive.version.created"), "no version landed");
  assert.deepEqual(pw.seen.aborted, [`POST ${TARGET}/api/v1/runs`]);
});

test("an unrunnable step fails the dry run as recording_step_failed naming the step (the RC1 spec's step-1 shape)", async () => {
  const dir = specDir(`
    await page.goto(meta.url);
    await step("Open the Studio Project", async () => { await page.click("#nav"); await page.waitForURL("**/p/**"); });
  `);
  const pw = fakePlaywright({ actions: ACTIONS, failWaitForUrl: true });
  const err = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright }).then(() => null, (e) => e);
  const typed = classifyRecorderError(err);
  assert.equal(typed.code, "recording_step_failed");
  assert.deepEqual(typed.step, { index: 1, label: "Open the Studio Project" });
  assert.match(typed.message, /waitForURL/);
});

test("a spec asking for meta.mode 'interactive' is refused (recording_spec_invalid) before the browser launches", async () => {
  const dir = specDir(`await page.goto(meta.url);`, `, mode: "interactive"`);
  const pw = fakePlaywright();
  const err = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright }).then(() => null, (e) => e);
  assert.equal(err?.code, "recording_spec_invalid");
  assert.match(err.message, /read-only/);
  assert.equal(pw.seen.contextOpts, null, "no browser context was opened");
});

test("a write sent before the first step (run() itself) fails the dry run", async () => {
  const dir = specDir(`
    await page.goto(meta.url);
    await page.click("#launch");
    await step("Look around", async () => {});
  `);
  const pw = fakePlaywright({ actions: ACTIONS });
  const err = await recordDemo(dir, { dryRun: true, importPlaywright: pw.importPlaywright }).then(() => null, (e) => e);
  assert.equal(err?.code, "side_effect_blocked");
  assert.match(err.message, /before the first step/);
  assert.equal(err.step, undefined);
});
