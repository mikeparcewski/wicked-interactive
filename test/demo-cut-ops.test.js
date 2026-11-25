// One route, one writer: the recut takes chapter ops that the cut module folds, validates and renders once; every cut
// mutation is guarded by the manifest head; the cut's state is the snapshot of its newest cut version, committed by the
// manifest write; no other writer lands a page version on a cut (studio#1140, ask 1, part A).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest, rethemeHead } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { materializeFeedback, materializeEdit, materializeDraft, materializeDemo, materializeDeckOp } from "../src/service/handlers.js";
import { defaultStyle, renderCut, recutCut, importCut, restoreCut, loadCut, loadCutVersion, currentCut, cutExists, isCut,
  findRequest, cutSnapshotFile, extractTakes, CUT_FILE } from "../src/service/demo-cut.js";

function fixture(t, { html = "<h1>Tour</h1>" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wi-cut-ops-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, html, { kind: "demo" });
  mkdirSync(join(dir, "recordings"));
  for (const f of ["_take-one-1.mp4", "_take-one-2.mp4", "_take-two-1.mp4", "_take-three-1.mp4"]) writeFileSync(join(dir, "recordings", f), "take");
  return dir;
}
function cut() {
  return { rev: 0, version: null, url: "http://127.0.0.1:7721/apps/x", chapters: [
    { id: "one", title: "One", say: "First", take: "_take-one-1.mp4", inSec: 0, outSec: 4 },
    { id: "two", title: "Two", say: "Second", take: "_take-two-1.mp4", inSec: 0, outSec: 3 },
    { id: "three", title: "Three", say: "Third", take: "_take-three-1.mp4", inSec: 0, outSec: 3 },
  ], takes: {
    one: [{ file: "_take-one-1.mp4", durationSec: 4, at: "2026-11-07T00:00:00Z" }, { file: "_take-one-2.mp4", durationSec: 6, at: "2026-11-07T00:00:01Z" }],
    two: [{ file: "_take-two-1.mp4", durationSec: 3, at: "2026-11-07T00:00:00Z" }],
    three: [{ file: "_take-three-1.mp4", durationSec: 3, at: "2026-11-07T00:00:00Z" }],
  }, style: defaultStyle("Tour") };
}
function recorder() {
  const seen = { renders: 0 };
  const runner = (args) => {
    if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
    if (args.some((a) => String(a).endsWith(".mp4") && String(a).includes("_v"))) seen.renders += args.includes("-filter_complex") ? 1 : 0;
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  return { seen, opts: { runner, skin: null, fetchSkin: async () => null } };
}
const head = (dir) => loadManifest(dir).head;
const refused = (field) => (e) => e.status === 400 && e.payload.error === "invalid_body" && e.payload.field === field;

async function seeded(t) {
  const dir = fixture(t), rec = recorder();
  const v1 = await renderCut(dir, cut(), rec.opts);
  return { dir, rec, v1 };
}

test("ops fold in order: a take resets the trim, a later trim wins, moves chain", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const out = await recutCut(dir, { expect_head: v1.version, ops: [
    { op: "chapter-take", chapter: "one", take: "_take-one-2.mp4" },
    { op: "chapter-trim", chapter: "one", inSec: 1, outSec: 5 },
    { op: "chapter-move", chapter: "three", after: null },
    { op: "chapter-move", chapter: "one", after: "three" },
    { op: "chapter-rename", chapter: "two", title: "Second" },
    { op: "chapter-say", chapter: "two", say: "New words" },
  ] }, rec.opts);
  assert.equal(out.version, v1.version + 1);
  const saved = loadCut(dir);
  assert.deepEqual(saved.chapters.map((c) => c.id), ["three", "one", "two"]);
  const one = saved.chapters[1];
  assert.deepEqual([one.take, one.inSec, one.outSec], ["_take-one-2.mp4", 1, 5]);
  assert.equal(saved.chapters[2].title, "Second");
  assert.equal(saved.chapters[2].say, "New words");
  assert.equal(saved.rev, 2);
  assert.equal(head(dir), out.version);
  const reset = await recutCut(dir, { expect_head: out.version, ops: [
    { op: "chapter-trim", chapter: "one", inSec: 2, outSec: 3 },
    { op: "chapter-take", chapter: "one", take: "_take-one-1.mp4" },
  ] }, rec.opts);
  const after = loadCutVersion(dir, reset.version).chapters.find((c) => c.id === "one");
  assert.deepEqual([after.inSec, after.outSec], [0, 4], "the take came after the trim and reset it");
});

test("a bad middle op refuses the whole batch and nothing moves", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const before = readFileSync(join(dir, "versions.json"), "utf8");
  const marker = readFileSync(join(dir, CUT_FILE), "utf8");
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [
    { op: "chapter-rename", chapter: "one", title: "Renamed" },
    { op: "chapter-take", chapter: "one", take: "_take-one-9.mp4" },
    { op: "chapter-rename", chapter: "two", title: "Also" },
  ] }, rec.opts), refused("ops.1.take"));
  for (const [ops, field] of [
    [[{ op: "chapter-trim", chapter: "one", inSec: 0, outSec: 99 }], "ops.0.outSec"],
    [[{ op: "chapter-move", chapter: "one", after: "one" }], "ops.0.after"],
    [[{ op: "chapter-move", chapter: "one", after: "nope" }], "ops.0.after"],
    [[{ op: "chapter-rename", chapter: "nope", title: "x" }], "ops.0.chapter"],
    [[{ op: "chapter-rename", chapter: "one", title: "x".repeat(81) }], "ops.0.title"],
    [[{ op: "chapter-delete", chapter: "one" }], "ops.0.op"],
    [[{ op: "chapter-rename", chapter: "one", title: "x", extra: 1 }], "ops.0.extra"],
  ]) await assert.rejects(recutCut(dir, { expect_head: v1.version, ops }, rec.opts), refused(field));
  assert.equal(readFileSync(join(dir, "versions.json"), "utf8"), before);
  assert.equal(readFileSync(join(dir, CUT_FILE), "utf8"), marker);
  assert.equal(head(dir), v1.version);
});

test("an .mp4 take from the cut's own inventory is accepted", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const out = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-take", chapter: "one", take: "_take-one-2.mp4" }] }, rec.opts);
  assert.equal(loadCutVersion(dir, out.version).chapters[0].take, "_take-one-2.mp4");
});

test("chapter-say is one line of at most 2000 characters; at most 20 ops", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const say = (value) => recutCut(dir, { expect_head: head(dir), ops: [{ op: "chapter-say", chapter: "one", say: value }] }, rec.opts);
  await assert.rejects(say("x".repeat(2001)), refused("ops.0.say"));
  await assert.rejects(say("two\nlines"), refused("ops.0.say"));
  await assert.rejects(say("two\rlines"), refused("ops.0.say"));
  await assert.rejects(say(7), refused("ops.0.say"));
  assert.equal(head(dir), v1.version);
  await say("x".repeat(2000));
  const rename = (n) => Array.from({ length: n }, (_, i) => ({ op: "chapter-rename", chapter: "one", title: `T${i}` }));
  await assert.rejects(recutCut(dir, { expect_head: head(dir), ops: rename(21) }, rec.opts), refused("ops"));
  await assert.rejects(recutCut(dir, { expect_head: head(dir), ops: [] }, rec.opts), refused("ops"));
  const twenty = await recutCut(dir, { expect_head: head(dir), ops: rename(20) }, rec.opts);
  assert.equal(loadCutVersion(dir, twenty.version).chapters[0].title, "T19");
});

test("a request_id replay returns the same version and renders nothing; the read finds it", async (t) => {
  const { dir, rec } = await seeded(t);
  const body = { expect_head: head(dir), request_id: "req-1", ops: [{ op: "chapter-rename", chapter: "one", title: "Once" }] };
  const first = await recutCut(dir, body, rec.opts);
  assert.equal(findRequest(dir, "req-1").version, first.version);
  assert.equal(loadManifest(dir).versions.find((v) => v.version === first.version).request_id, "req-1");
  const renders = rec.seen.renders;
  const again = await recutCut(dir, body, rec.opts);
  assert.equal(again.version, first.version);
  assert.equal(again.replayed, true);
  assert.equal(rec.seen.renders, renders, "nothing rendered");
  assert.equal(head(dir), first.version);
  assert.equal(findRequest(dir, "never"), null);
  for (const request_id of ["", "x".repeat(129), 4]) {
    await assert.rejects(recutCut(dir, { ...body, request_id }, rec.opts), refused("request_id"));
  }
  await recutCut(dir, { ...body, expect_head: head(dir), request_id: "x".repeat(128) }, rec.opts);
});

test("a stale expect_head is 409 head_moved on recut and restore", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const v2 = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Two" }] }, rec.opts);
  const stale = (e) => e.status === 409 && e.payload.error === "head_moved" && e.payload.head === v2.version;
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Late" }] }, rec.opts), stale);
  await assert.rejects(recutCut(dir, { expect_head: v1.version, chapters: [{ id: "one" }, { id: "two" }, { id: "three" }], rev: 2 }, rec.opts), stale);
  await assert.rejects(restoreCut(dir, { expect_head: v1.version, from: v1.version }, rec.opts), stale);
  await assert.rejects(recutCut(dir, { ops: [{ op: "chapter-rename", chapter: "one", title: "x" }] }, rec.opts), refused("expect_head"));
  assert.equal(head(dir), v2.version);
  const restored = await restoreCut(dir, { expect_head: v2.version, from: v1.version }, rec.opts);
  assert.equal(restored.parent, v2.version);
});

test("the old recut body keeps working, with or without expect_head", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const a = await recutCut(dir, { rev: 1, chapters: [{ id: "two" }, { id: "one" }, { id: "three" }] }, rec.opts);
  assert.equal(a.rev, 2);
  const b = await recutCut(dir, { rev: 2, expect_head: a.version, chapters: [{ id: "one" }, { id: "two" }, { id: "three" }] }, rec.opts);
  assert.equal(b.version, a.version + 1);
  await assert.rejects(recutCut(dir, { rev: 2, chapters: [{ id: "one" }, { id: "two" }, { id: "three" }] }, rec.opts), (e) => e.payload.error === "rev_moved");
  await assert.rejects(recutCut(dir, { rev: 3, chapters: [{ id: "one", say: "no" }, { id: "two" }, { id: "three" }] }, rec.opts), refused("chapters.0.say"));
  assert.ok(v1);
});

// ── publication boundary ────────────────────────────────────────────────────────────────────────

const killAt = (step) => ({ onPublish: (s) => { if (s === step) throw new Error(`killed after ${s}`); } });

for (const step of ["snapshot", "marker"]) {
  test(`a later edit killed after the ${step} write leaves the previous commit in force; a retry succeeds`, async (t) => {
    const { dir, rec, v1 } = await seeded(t);
    const ops = [{ op: "chapter-rename", chapter: "one", title: "Killed" }];
    await assert.rejects(recutCut(dir, { expect_head: v1.version, ops }, { ...rec.opts, ...killAt(step) }), /killed/);
    assert.equal(head(dir), v1.version, "the manifest is the commit point");
    assert.equal(loadCut(dir).chapters[0].title, "One");
    assert.equal(loadCut(dir).rev, 1);
    const retry = await recutCut(dir, { expect_head: v1.version, ops }, rec.opts);
    assert.ok(retry.version > v1.version);
    assert.equal(loadCut(dir).chapters[0].title, "Killed");
    assert.equal(loadCutVersion(dir, retry.version).rev, 2);
  });
}

test("a later edit killed after the manifest write is committed exactly as described", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Done" }] }, { ...rec.opts, ...killAt("manifest") }), /killed/);
  assert.ok(head(dir) > v1.version);
  assert.equal(loadCut(dir).chapters[0].title, "Done");
  assert.equal(JSON.parse(readFileSync(join(dir, CUT_FILE), "utf8")).chapters[0].title, "Done");
  const next = await recutCut(dir, { expect_head: head(dir), ops: [{ op: "chapter-rename", chapter: "one", title: "Again" }] }, rec.opts);
  assert.equal(loadCut(dir).rev, 3);
  assert.ok(next.version > head(dir) - 1);
});

test("a first creation killed after the marker, and before the manifest, is no cut and a retry succeeds", async (t) => {
  const dir = fixture(t), rec = recorder();
  const seen = [];
  await assert.rejects(renderCut(dir, cut(), { ...rec.opts, onPublish: (step) => {
    seen.push(isCut(dir) && !existsSync(join(dir, "recordings", "_v1.ass")));
    if (step === "marker") throw new Error("killed after marker");
  } }), /killed/);
  assert.deepEqual(seen, [true], "the marker precedes the first output file");
  assert.ok(isCut(dir), "the marker is written first");
  assert.equal(currentCut(dir), null);
  assert.equal(cutExists(dir), false, "an import or a first take is not refused as cut_exists");
  assert.throws(() => loadCut(dir), (e) => e.status === 404 && e.payload.error === "no_cut");
  assert.equal(head(dir), 0);
  const retry = await renderCut(dir, cut(), rec.opts);
  assert.equal(head(dir), retry.version);
  assert.equal(loadCut(dir).version, retry.version);
  assert.equal(cutExists(dir), true);
});

test("a first creation killed after the snapshot, or after the manifest, is the same story", async (t) => {
  const dir = fixture(t), rec = recorder();
  await assert.rejects(renderCut(dir, cut(), { ...rec.opts, ...killAt("snapshot") }), /killed/);
  assert.equal(currentCut(dir), null);
  const retry = await renderCut(dir, cut(), rec.opts);
  const other = fixture(t);
  await assert.rejects(renderCut(other, cut(), { ...rec.opts, ...killAt("manifest") }), /killed/);
  assert.equal(loadCut(other).chapters.length, 3, "committed");
  assert.ok(retry.version >= 1);
});

// ── legacy cuts ─────────────────────────────────────────────────────────────────────────────────

test("a legacy cut whose marker names the newest cut version is verified by a read and backfilled by the next edit", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const snapshot = join(dir, cutSnapshotFile(v1.version));
  rmSync(snapshot);
  assert.equal(loadCutVersion(dir, v1.version, { write: false }).version, v1.version);
  assert.equal(loadCut(dir, { write: false }).version, v1.version);
  assert.equal(cutExists(dir), true);
  assert.ok(!existsSync(snapshot), "a read writes nothing");
  const out = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Legacy" }] }, rec.opts);
  assert.ok(existsSync(snapshot), "the first edit in the queue wrote it");
  assert.equal(loadCutVersion(dir, v1.version).chapters[0].title, "One");
  assert.equal(loadCut(dir).version, out.version);
});

test("an import killed after its files moved and its marker was written is retried from the takes where they lie", async (t) => {
  const dir = fixture(t);
  const runner = (args) => {
    if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
    if (args.includes("-i") && args.length === 3) return { status: 1, stderr: "  Duration: 00:00:04.00, start: 0.0, bitrate: 1 kb/s\n  Stream #0:0: Video: h264\n" };
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  const opts = { runner, skin: null, fetchSkin: async () => null };
  const stage = () => writeFileSync(join(dir, "recordings", "_import-one.mp4"), "bytes");
  stage();
  await assert.rejects(importCut(dir, { chapters: [{ id: "one", title: "One" }] }, { ...opts, ...killAt("marker") }), /killed/);
  // The process died instead of unwinding: the staged file is gone, the take is in place.
  renameSync(join(dir, "recordings", "_import-one.mp4"), join(dir, "recordings", "_take-one-1.mp4"));
  assert.equal(cutExists(dir), false);
  const out = await importCut(dir, { chapters: [{ id: "one", title: "One" }] }, opts);
  assert.equal(head(dir), out.version);
  assert.equal(loadCut(dir).chapters[0].take, "_take-one-1.mp4");
  assert.equal(loadCut(dir).chapters[0].outSec, 4);
});

test("a legacy cut whose marker does not match gets cut_unverified on every edit", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  rmSync(join(dir, cutSnapshotFile(v1.version)));
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), version: 0, rev: 4 }));
  const unverified = (e) => e.status === 409 && e.payload.error === "cut_unverified" && /Record it again/.test(e.payload.message);
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "x" }] }, rec.opts), unverified);
  await assert.rejects(recutCut(dir, { rev: 4, chapters: [{ id: "one" }, { id: "two" }, { id: "three" }] }, rec.opts), unverified);
  await assert.rejects(restoreCut(dir, { rev: 4, from: 0 }, rec.opts), unverified);
  assert.throws(() => loadCutVersion(dir, v1.version), unverified);
  assert.equal(cutExists(dir), true, "an import is still refused");
  assert.equal(head(dir), v1.version);
});

test("a legacy recorder storyboard (kind demo, no render) is not a cut version", async (t) => {
  const { dir, v1 } = await seeded(t);
  const manifest = JSON.parse(readFileSync(join(dir, "versions.json"), "utf8"));
  manifest.versions.push({ version: v1.version + 1, parent: v1.version, kind: "demo" });
  manifest.head = v1.version + 1;
  writeFileSync(join(dir, "versions.json"), JSON.stringify(manifest));
  assert.equal(loadCut(dir).version, v1.version);
  assert.throws(() => loadCutVersion(dir, v1.version + 1), (e) => e.payload.error === "no_snapshot");
});

// ── every other writer refuses a cut ────────────────────────────────────────────────────────────

function spyCtx() {
  const events = [];
  return { documentId: "t1", events, emit: (type, payload) => events.push({ type, payload }) };
}
const cutDocument = (ctx) => ctx.events.filter((e) => e.payload.code === "cut_document" && e.payload.retryable === false);

test("the bus handlers refuse a cut with cut_document, land nothing, and still work on a plain document", async (t) => {
  const { dir } = await seeded(t);
  const before = readFileSync(join(dir, "versions.json"), "utf8");
  const ctx = spyCtx();
  const item = { selector: "slide-0-heading-1", type: "content-edit", value: "Hi" };
  const out = [
    await materializeFeedback(dir, { items: [item] }, ctx),
    await materializeEdit(dir, { version: 1, results: [] }, ctx),
    await materializeDraft(dir, { html: "<section><h1>X</h1></section>" }, ctx),
    await materializeDemo(dir, {}, ctx, { record: async () => assert.fail("recorded") }),
  ];
  assert.ok(out.every((o) => o.refused === "this document is a demo cut"));
  assert.equal(cutDocument(ctx).length, 4);
  assert.deepEqual(await materializeDeckOp(dir, { expect_head: head(dir), op: { type: "slide-move", slide: "s", after: null } }, ctx), { cutDocument: true });
  assert.equal(readFileSync(join(dir, "versions.json"), "utf8"), before);

  const plain = mkdtempSync(join(tmpdir(), "wi-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  initWorkspace(plain, "<h1>Q2 Results</h1><p>body</p>");
  const pctx = spyCtx();
  const fb = await materializeFeedback(plain, { items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }] }, pctx);
  const frag = fb.structural_items[0].fragment.replace(/Q2 Results/, "Q2 Crushed");
  assert.equal((await materializeEdit(plain, { version: fb.version, results: [{ selector: "slide-0-heading-1", fragment: frag }] }, pctx)).version, 1);
  assert.equal((await materializeFeedback(plain, { items: [{ ...item, value: "Q3" }] }, pctx)).version, 2);
  assert.equal((await materializeDraft(plain, { html: "<section><h1>X</h1></section>" }, pctx)).version, 3);
  let recorded = 0;
  const demoCtx = { ...pctx, recorder: { status: async () => ({ ok: true, browser: "chromium-headless-shell", missing: [], components: [] }) } };
  await materializeDemo(plain, {}, demoCtx, { record: async () => { recorded += 1; return { version: 4, parent: 3 }; } });
  assert.equal(recorded, 1);
  assert.deepEqual(await materializeDeckOp(plain, { expect_head: 3, op: { type: "slide-move", slide: "s", after: null } }, pctx), { notDeck: true });
  assert.equal(cutDocument(pctx).length, 0);
});

// ── routes ──────────────────────────────────────────────────────────────────────────────────────

test("routes: ops recut, request_id read, head_moved on style and takes, cut_document on re-theme, read-back timing", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const record = async () => assert.fail("takes recorded over a moved head");
  const svc = createServer({ dir, documentId: "tour", demoCut: { ...rec.opts, record }, themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const req = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const done = await req("POST", "/api/demo/recut", { expect_head: v1.version, request_id: "r-1", ops: [{ op: "chapter-trim", chapter: "two", inSec: 1, outSec: 3 }] });
  assert.equal(done.status, 200);
  assert.equal(done.body.version, v1.version + 1);
  assert.deepEqual(await req("GET", "/api/demo/cut?request_id=r-1"), { status: 200, body: { request_id: "r-1", version: done.body.version } });
  assert.equal((await req("GET", "/api/demo/cut?request_id=nope")).status, 404);
  assert.equal((await req("GET", `/api/demo/cut?request_id=${"x".repeat(129)}`)).status, 400);
  const replay = await req("POST", "/api/demo/recut", { expect_head: v1.version, request_id: "r-1", ops: [{ op: "chapter-trim", chapter: "two", inSec: 1, outSec: 3 }] });
  assert.equal(replay.body.version, done.body.version);
  const read = await req("GET", "/api/demo/cut");
  assert.deepEqual(read.body.chapters.map((c) => [c.id, c.startSec, c.durationSec]), [["one", 2.5, 4], ["two", 6.5, 2], ["three", 8.5, 3]]);
  assert.equal(read.body.render.mp4, `_v${done.body.version}.mp4`);
  assert.equal((await req("GET", `/api/demo/cut?version=${v1.version}`)).body.render.mp4, `_v${v1.version}.mp4`);
  const moved = { status: 409, body: { error: "head_moved", head: done.body.version } };
  assert.deepEqual(await req("PUT", "/api/demo/style", { expect_head: v1.version, style: {} }), moved);
  assert.deepEqual(await req("POST", "/api/demo/takes", { expect_head: v1.version }), moved);
  assert.deepEqual(await req("POST", "/api/demo/restore", { expect_head: v1.version, from: v1.version }), moved);
  assert.equal((await req("PUT", "/api/demo/style", { expect_head: done.body.version, style: { captions: { size: 48 } } })).status, 200);
  const themed = await req("PUT", "/api/theme/learned", { tokens: { name: "t", colors: { background: "#0B1020", primary: "#8FB4FF", text_primary: "#E6E9F5" }, fonts: { heading: "Inter", body: "Inter, sans-serif" } }, apply: true });
  assert.equal(themed.status, 409);
  assert.equal(themed.body.error, "cut_document");
  const deck = await req("POST", "/api/deck", { expect_head: head(dir), op: { type: "slide-move", slide: "s", after: null } });
  assert.deepEqual([deck.status, deck.body.error], [409, "cut_document"]);
});

// ── an old-style cut: demo-cut.json only, no cut version in the manifest ────────────────────────

test("an old-style cut keeps its demo-cut.json when a render fails, and gets the new one once a render lands", async (t) => {
  const dir = fixture(t), rec = recorder();
  const old = JSON.stringify({ ...cut(), rev: 5, version: 0 });
  writeFileSync(join(dir, CUT_FILE), old);
  const failing = { runner: (args) => (args.includes("-filters") ? { status: 0, stderr: " ... ass V->V\n" } : { status: 1, stderr: "encode failed" }), skin: null, fetchSkin: async () => null };
  await assert.rejects(renderCut(dir, loadCut(dir), failing), /ffmpeg_failed/);
  assert.equal(readFileSync(join(dir, CUT_FILE), "utf8"), old, "byte-identical");
  assert.equal(loadCut(dir).rev, 5);
  const out = await renderCut(dir, loadCut(dir), rec.opts);
  const marker = JSON.parse(readFileSync(join(dir, CUT_FILE), "utf8"));
  assert.deepEqual([marker.rev, marker.version], [6, out.version]);
  assert.equal(loadCut(dir).rev, 6);
});

// ── the chat's route (studio#1140 option (a), lane b7-video): fixes from the 13 Nov review and the DES-1140A delta ──

test("F3: an op validates only what it touches; a recorder's long title or multi-line narration elsewhere does not refuse it", async (t) => {
  const dir = fixture(t), rec = recorder();
  const legacy = cut();
  legacy.chapters[0].title = "A recorder label that is much longer than the eighty characters a hand rename may set ok";
  legacy.chapters[1].say = "First line\nsecond line";
  const v1 = await renderCut(dir, legacy, rec.opts);
  const out = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-trim", chapter: "three", inSec: 1, outSec: 3 }] }, rec.opts);
  const saved = loadCutVersion(dir, out.version);
  assert.equal(saved.chapters[0].title, legacy.chapters[0].title, "untouched title kept");
  assert.equal(saved.chapters[1].say, "First line\nsecond line", "untouched narration kept");
  await assert.rejects(recutCut(dir, { expect_head: out.version, ops: [{ op: "chapter-rename", chapter: "one", title: "x".repeat(81) }] }, rec.opts), refused("ops.0.title"));
  const renamed = await recutCut(dir, { expect_head: out.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Short now" }] }, rec.opts);
  assert.equal(loadCutVersion(dir, renamed.version).chapters[0].title, "Short now");
});

test("F2: Record it again works on an unverified history: a full take starts a verified cut", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  rmSync(join(dir, cutSnapshotFile(v1.version)));
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), version: 0, rev: 4 }));
  writeFileSync(join(dir, "recordings", "run.webm"), "raw");
  const steps = [{ label: "One", at: 0, say: "First" }, { label: "Two", at: 2, say: "Second" }];
  const out = await extractTakes(dir, "run.webm", steps, 5, { title: "Tour" }, rec.opts);
  assert.equal(head(dir), out.version);
  const now = loadCut(dir);
  assert.equal(now.version, out.version);
  assert.deepEqual(now.chapters.map((c) => c.id), ["one", "two"]);
  assert.ok(now.rev > 4, "the rev keeps counting up from the old marker");
  await assert.rejects(extractTakes(dir, "run.webm", steps, 5, { title: "Tour" }, { ...rec.opts, chapter: "nope" }), refused("chapter"));
});

test("F1: an old-style cut killed at any publication step reads a whole cut, never none", async (t) => {
  for (const step of ["snapshot", "manifest", "marker"]) {
    const dir = fixture(t), rec = recorder();
    writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), rev: 5, version: 0 }));
    await assert.rejects(renderCut(dir, loadCut(dir), { ...rec.opts, ...killAt(step) }), /killed/);
    const now = currentCut(dir);
    assert.ok(now !== null, `killed after ${step}: still a cut`);
    if (step === "snapshot") assert.deepEqual([now.rev, now.version], [5, 0], "the previous commit stands");
    else assert.deepEqual([now.rev, now.version], [6, head(dir)], "committed by the manifest");
    const out = await renderCut(dir, loadCut(dir), rec.opts);
    assert.equal(loadCut(dir).version, out.version, `killed after ${step}: a retry succeeds`);
  }
});

test("F5: an intact earlier version reads back even when the head's history is unverified", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const v2 = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Two" }] }, rec.opts);
  rmSync(join(dir, cutSnapshotFile(v2.version)));
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), version: 0, rev: 9 }));
  assert.equal(loadCutVersion(dir, v1.version, { write: false }).chapters[0].title, "One");
  assert.throws(() => loadCut(dir, { write: false }), (e) => e.payload.error === "cut_unverified");
});

test("F6: a restore with a stale rev and a stale head answers head_moved", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const v2 = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Two" }] }, rec.opts);
  await assert.rejects(restoreCut(dir, { rev: 0, from: v1.version, expect_head: v1.version }, rec.opts),
    (e) => e.status === 409 && e.payload.error === "head_moved" && e.payload.head === v2.version);
});

test("a trim is checked per op, against its take as folded so far, and the refusal names the op", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const trim = (ops) => recutCut(dir, { expect_head: v1.version, ops }, rec.opts);
  await assert.rejects(trim([{ op: "chapter-take", chapter: "one", take: "_take-one-1.mp4" }, { op: "chapter-trim", chapter: "one", inSec: 0, outSec: 5 }]), refused("ops.1.outSec"));
  await assert.rejects(trim([{ op: "chapter-rename", chapter: "two", title: "x" }, { op: "chapter-trim", chapter: "two", inSec: -1, outSec: 2 }]), refused("ops.1.inSec"));
  await assert.rejects(trim([{ op: "chapter-trim", chapter: "two", inSec: 1, outSec: 1.2 }]), refused("ops.0.outSec"));
  await assert.rejects(trim([{ op: "chapter-trim", chapter: "one", inSec: 0, outSec: 99 }]), refused("ops.0.outSec"));
  assert.equal(head(dir), v1.version, "nothing rendered");
  const ok = await trim([{ op: "chapter-take", chapter: "one", take: "_take-one-2.mp4" }, { op: "chapter-trim", chapter: "one", inSec: 0, outSec: 5.5 }]);
  assert.equal(loadCutVersion(dir, ok.version).chapters[0].outSec, 5.5);
});

test("chapter-drop removes a chapter, keeps its takes, refuses the last one and a later op on it; Undo brings it back", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "two" }, { op: "chapter-rename", chapter: "two", title: "x" }] }, rec.opts), refused("ops.1.chapter"));
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "one" }, { op: "chapter-drop", chapter: "two" }, { op: "chapter-drop", chapter: "three" }] }, rec.opts), refused("ops.2.chapter"));
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "two", extra: true }] }, rec.opts), refused("ops.0.extra"));
  assert.equal(head(dir), v1.version);
  const dropped = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "two" }, { op: "chapter-move", chapter: "three", after: null }] }, rec.opts);
  const now = loadCut(dir);
  assert.deepEqual(now.chapters.map((c) => c.id), ["three", "one"]);
  assert.ok(now.takes.two.length > 0, "the dropped chapter's takes stay in the inventory");
  assert.ok(!readFileSync(join(dir, "recordings", `_v${dropped.version}.vtt`), "utf8").includes("Second"), "its caption is gone from the video");
  // A hand edit in the old body after the drop sends the chapters the cut has.
  const hand = await recutCut(dir, { rev: now.rev, chapters: [{ id: "three" }, { id: "one", title: "First" }] }, rec.opts);
  await assert.rejects(recutCut(dir, { rev: loadCut(dir).rev, chapters: [{ id: "three" }, { id: "one" }, { id: "two" }] }, rec.opts), refused("chapters"));
  const undo = await restoreCut(dir, { from: v1.version, expect_head: hand.version }, rec.opts);
  assert.deepEqual(loadCutVersion(dir, undo.version).chapters.map((c) => c.id), ["one", "two", "three"]);
});

test("routes: GET cut says the manifest head; the request_id read echoes the id", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const svc = createServer({ dir, documentId: "tour", demoCut: rec.opts, themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const read = await get("/api/demo/cut");
  assert.deepEqual([read.body.head, read.body.version], [v1.version, v1.version]);
  const done = await post("/api/demo/recut", { expect_head: v1.version, request_id: "chat-1", ops: [{ op: "chapter-drop", chapter: "two" }] });
  assert.equal(done.status, 200);
  assert.deepEqual(await get("/api/demo/cut?request_id=chat-1"), { status: 200, body: { request_id: "chat-1", version: done.body.version } });
  const themed = rethemeHead(dir, { colors: { primary: "#123456" } });
  const after = await get("/api/demo/cut");
  assert.deepEqual([after.body.head, after.body.version], [themed.version, done.body.version], "a page version over the cut: head is not the cut's version");
});

test("an op's refusal says why: unknown, dropped, self, last_chapter, out_of_take, too_short, format", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const why = (field, reason) => (e) => e.status === 400 && e.payload.error === "invalid_body" && e.payload.field === field && e.payload.reason === reason;
  for (const [ops, field, reason] of [
    [[{ op: "chapter-rename", chapter: "nope", title: "x" }], "ops.0.chapter", "unknown"],
    [[{ op: "chapter-move", chapter: "one", after: "nope" }], "ops.0.after", "unknown"],
    [[{ op: "chapter-drop", chapter: "two" }, { op: "chapter-rename", chapter: "two", title: "x" }], "ops.1.chapter", "dropped"],
    [[{ op: "chapter-drop", chapter: "two" }, { op: "chapter-move", chapter: "one", after: "two" }], "ops.1.after", "dropped"],
    [[{ op: "chapter-drop", chapter: "two" }, { op: "chapter-drop", chapter: "two" }], "ops.1.chapter", "dropped"],
    [[{ op: "chapter-move", chapter: "one", after: "one" }], "ops.0.after", "self"],
    [[{ op: "chapter-drop", chapter: "one" }, { op: "chapter-drop", chapter: "two" }, { op: "chapter-drop", chapter: "three" }], "ops.2.chapter", "last_chapter"],
    [[{ op: "chapter-trim", chapter: "two", inSec: 0, outSec: 9 }], "ops.0.outSec", "out_of_take"],
    [[{ op: "chapter-trim", chapter: "two", inSec: -1, outSec: 2 }], "ops.0.inSec", "out_of_take"],
    [[{ op: "chapter-trim", chapter: "two", inSec: 1, outSec: 1.2 }], "ops.0.outSec", "too_short"],
    [[{ op: "chapter-rename", chapter: "one", title: "x".repeat(81) }], "ops.0.title", "format"],
    [[{ op: "chapter-say", chapter: "one", say: "a\nb" }], "ops.0.say", "format"],
  ]) await assert.rejects(recutCut(dir, { expect_head: v1.version, ops }, rec.opts), why(field, reason), JSON.stringify(ops));
  assert.equal(head(dir), v1.version);
});

test("routes: a request_id that is queued or rendering reads 202 pending, then 200 once committed", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (args) => { if (!args.includes("-filters")) await gate; return rec.opts.runner(args); };
  const svc = createServer({ dir, documentId: "tour", demoCut: { ...rec.opts, runner: slow }, themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const posted = fetch(base + "/api/demo/recut", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expect_head: v1.version, request_id: "chat-2", ops: [{ op: "chapter-rename", chapter: "one", title: "Hi" }] }) });
  try {
    for (let i = 0; i < 50 && (await get("/api/demo/cut?request_id=chat-2")).status === 404; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await get("/api/demo/cut?request_id=chat-2"), { status: 202, body: { request_id: "chat-2", pending: true } });
  } finally { release(); }
  const done = await (await posted).json();
  assert.deepEqual(await get("/api/demo/cut?request_id=chat-2"), { status: 200, body: { request_id: "chat-2", version: done.version } });
  assert.equal((await get("/api/demo/cut?request_id=other")).status, 404);
});

// ── round-1 review folds (codex + pi on the local diff) ──────────────────────────────────────────────────────────

test("a dropped chapter stays dropped when one chapter or all of them are recorded again", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "two" }] }, rec.opts);
  writeFileSync(join(dir, "recordings", "run.webm"), "raw");
  const steps = [{ label: "One", at: 0, say: "First" }, { label: "Two", at: 2, say: "Second" }, { label: "Three", at: 4, say: "Third" }];
  await extractTakes(dir, "run.webm", steps, 6, { title: "Tour" }, { ...rec.opts, chapter: "one" });
  assert.deepEqual(loadCut(dir).chapters.map((c) => c.id), ["one", "three"]);
  const full = await extractTakes(dir, "run.webm", steps, 6, { title: "Tour" }, rec.opts);
  const now = loadCut(dir);
  assert.deepEqual(now.chapters.map((c) => c.id), ["one", "three"], "a full take keeps the drop");
  assert.ok(now.takes.two.some((x) => x.file === full.takes.find((a) => a.chapter === "two").file), "its new take joins the inventory");
});

test("F2 recovery keeps the marker's style; a one-chapter take is still refused before it", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  rmSync(join(dir, cutSnapshotFile(v1.version)));
  const style = defaultStyle("Tour");
  style.captions.on = false;
  style.theme.endCard.title = "See you";
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), style, version: 0, rev: 4 }));
  writeFileSync(join(dir, "recordings", "run.webm"), "raw");
  const steps = [{ label: "One", at: 0, say: "First" }, { label: "Two", at: 2, say: "Second" }];
  await assert.rejects(extractTakes(dir, "run.webm", steps, 5, { title: "Tour" }, { ...rec.opts, chapter: "one" }), (e) => e.payload?.error === "cut_unverified");
  assert.equal(head(dir), v1.version, "nothing extracted");
  await extractTakes(dir, "run.webm", steps, 5, { title: "Tour" }, rec.opts);
  const now = loadCut(dir);
  assert.equal(now.rev, 5);
  assert.equal(now.style.captions.on, false);
  assert.equal(now.style.theme.endCard.title, "See you");
});

test("an import that committed keeps its takes when the step after the manifest fails", async (t) => {
  const dir = fixture(t);
  const runner = (args) => {
    if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
    if (args.includes("-i") && args.length === 3) return { status: 1, stderr: "  Duration: 00:00:04.00, start: 0.0, bitrate: 1 kb/s\n  Stream #0:0: Video: h264\n" };
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  const opts = { runner, skin: null, fetchSkin: async () => null };
  writeFileSync(join(dir, "recordings", "_import-one.mp4"), "bytes");
  await assert.rejects(importCut(dir, { chapters: [{ id: "one", title: "One" }] }, { ...opts, ...killAt("snapshot") }), /killed/);
  assert.ok(existsSync(join(dir, "recordings", "_import-one.mp4")), "uncommitted: the staged file came back");
  await assert.rejects(importCut(dir, { chapters: [{ id: "one", title: "One" }] }, { ...opts, ...killAt("marker") }), /killed/);
  assert.ok(existsSync(join(dir, "recordings", "_take-one-1.mp4")), "committed: the take stays where the cut names it");
  assert.equal(loadCut(dir).chapters[0].take, "_take-one-1.mp4");
});

test("malformed ops say why; an older version without a snapshot is no_snapshot under an unverified head", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  const why = (field, reason) => (e) => e.payload?.field === field && e.payload?.reason === reason;
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [7] }, rec.opts), why("ops.0", "format"));
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-explode", chapter: "one" }] }, rec.opts), why("ops.0.op", "unsupported"));
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-drop", chapter: "two", extra: true }] }, rec.opts), why("ops.0.extra", "format"));
  const v2 = await recutCut(dir, { expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Two" }] }, rec.opts);
  rmSync(join(dir, cutSnapshotFile(v1.version)));
  rmSync(join(dir, cutSnapshotFile(v2.version)));
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), version: 0, rev: 9 }));
  assert.throws(() => loadCutVersion(dir, v1.version, { write: false }), (e) => e.payload?.error === "no_snapshot");
  assert.throws(() => loadCutVersion(dir, v2.version, { write: false }), (e) => e.payload?.error === "cut_unverified");
});

test("routes: GET cut never pairs a cut with a newer head; pending holds while queued, ends on a refusal, never for a bad id", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  let hold = null, skinCalls = 0, unblock, entered;
  const skinGate = new Promise((r) => { unblock = r; });
  const inSkin = new Promise((r) => { entered = r; });
  const slow = async (args) => { if (hold !== null && !args.includes("-filters") && args.some((a) => String(a).includes("_v"))) await hold; return rec.opts.runner(args); };
  const fetchSkin = async () => { if (++skinCalls === 1) { entered(); await skinGate; } return null; };
  t.after(() => unblock());
  const svc = createServer({ dir, documentId: "tour", demoCut: { ...rec.opts, runner: slow, fetchSkin }, themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
  const post = (body) => fetch(base + "/api/demo/recut", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const reading = get("/api/demo/cut"); // held at its skin read
  await inSkin;
  const landed = await post({ expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Landed" }] });
  unblock();
  const read = await reading;
  assert.deepEqual([read.body.head, read.body.version, read.body.chapters[0].title], [v1.version, v1.version, "One"], "the cut and its head are one read");
  // A request queued behind a held render is pending; a refused one is not once it settles; a bad id never is.
  let release;
  hold = new Promise((r) => { release = r; });
  try {
    const held = post({ expect_head: landed.body.version, request_id: "a", ops: [{ op: "chapter-rename", chapter: "one", title: "A" }] });
    const queued = post({ expect_head: landed.body.version, request_id: "b", ops: [{ op: "chapter-explode", chapter: "one" }] });
    const bad = post({ expect_head: landed.body.version, request_id: "x".repeat(129), ops: [{ op: "chapter-rename", chapter: "one", title: "B" }] });
    for (let i = 0; i < 50 && (await get("/api/demo/cut?request_id=b")).status !== 202; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await get("/api/demo/cut?request_id=a")).status, 202, "the held render is pending");
    assert.equal((await get("/api/demo/cut?request_id=b")).status, 202, "queued behind it is pending");
    release();
    assert.equal((await held).status, 200);
    assert.equal((await queued).status, 409, "refused (the held one moved the head)");
    assert.equal((await bad).status, 400);
    assert.equal((await get("/api/demo/cut?request_id=b")).status, 404, "a refused request is not pending once it settles");
  } finally { release(); hold = null; }
});

test("routes: two requests sharing an id stay pending until the last one settles", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  // The first new version's encodes wait on one gate, every later version's on another.
  let first = null, later = false, releaseFirst, releaseLater;
  const firstGate = new Promise((r) => { releaseFirst = r; }), laterGate = new Promise((r) => { releaseLater = r; });
  const slow = async (args) => {
    const n = Number(args.map(String).join(" ").match(/_v(\d+)/)?.[1] ?? NaN);
    if (n > v1.version) { first ??= n; if (n !== first) later = true; await (n === first ? firstGate : laterGate); }
    return rec.opts.runner(args);
  };
  const svc = createServer({ dir, documentId: "tour", demoCut: { ...rec.opts, runner: slow }, themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const until = async (ok) => { for (let i = 0; i < 500 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); };
  const pending = async () => (await fetch(base + "/api/demo/cut?request_id=r")).status;
  const post = (body) => fetch(base + "/api/demo/recut", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
  try {
    const held = post({ expect_head: v1.version, ops: [{ op: "chapter-rename", chapter: "one", title: "Held" }] });
    await until(() => first !== null);
    assert.ok(first > v1.version, "the first render is held");
    // Behind it, a refused request, then a good one, share the id "r" (the refused one is queued first).
    const refused = post({ expect_head: first, request_id: "r", ops: [{ op: "chapter-explode", chapter: "one" }] });
    await until(async () => (await pending()) === 202);
    const good = post({ expect_head: first, request_id: "r", ops: [{ op: "chapter-rename", chapter: "two", title: "Good" }] });
    await new Promise((r) => setTimeout(r, 200));
    releaseFirst();
    assert.equal(await held, 200);
    assert.equal(await refused, 400);
    await until(() => later);
    assert.equal(await pending(), 202, "the good one still renders");
    releaseLater();
    assert.equal(await good, 200);
    assert.equal(await pending(), 200);
  } finally { releaseFirst(); releaseLater(); }
});

test("op names that are not strings are refused with a reason; a malformed marker style recovers with the defaults", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  await assert.rejects(recutCut(dir, { expect_head: v1.version, ops: [{ op: { toString: null }, chapter: "one" }] }, rec.opts),
    (e) => e.payload?.error === "invalid_body" && e.payload.field === "ops.0.op" && e.payload.reason === "format");
  rmSync(join(dir, cutSnapshotFile(v1.version)));
  const style = defaultStyle("Tour");
  style.theme.endCard = null;
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), style, version: 0, rev: 4 }));
  writeFileSync(join(dir, "recordings", "run.webm"), "raw");
  await extractTakes(dir, "run.webm", [{ label: "One", at: 0, say: "First" }], 3, { title: "Tour" }, rec.opts);
  assert.equal(loadCut(dir).style.theme.endCard.on, true, "the defaults");
});

test("a recording after a restore that merged another spec's takes is not read as a new spec", async (t) => {
  const { dir, rec, v1 } = await seeded(t);
  writeFileSync(join(dir, "recordings", "run.webm"), "raw");
  await extractTakes(dir, "run.webm", [{ label: "Four", at: 0, say: "x" }], 3, { title: "Tour" }, rec.opts);
  const back = await restoreCut(dir, { from: v1.version, expect_head: head(dir) }, rec.opts);
  assert.ok(loadCut(dir).takes.four, "the restore kept the other spec's takes");
  const steps = [{ label: "One", at: 0, say: "First" }, { label: "Two", at: 2, say: "Second" }, { label: "Three", at: 4, say: "Third" }];
  await extractTakes(dir, "run.webm", steps, 6, { title: "Tour" }, { ...rec.opts, chapter: "one" });
  assert.ok(head(dir) > back.version);
  assert.deepEqual(loadCut(dir).chapters.map((c) => c.id), ["one", "two", "three"]);
});

test("an old-style cut whose marker write fails after the commit still lands the version, read from its snapshot", async (t) => {
  const dir = fixture(t), rec = recorder();
  writeFileSync(join(dir, CUT_FILE), JSON.stringify({ ...cut(), rev: 5, version: 0 }));
  // The document folder turns read-only once the manifest has committed, so the marker's atomic write fails.
  const out = await renderCut(dir, { ...loadCut(dir), chapters: cut().chapters.map((c) => ({ ...c, title: `${c.title}!` })) },
    { ...rec.opts, onPublish: (step) => { if (step === "manifest") chmodSync(dir, 0o555); } }).finally(() => chmodSync(dir, 0o755));
  assert.equal(head(dir), out.version);
  assert.equal(JSON.parse(readFileSync(join(dir, CUT_FILE), "utf8")).rev, 5, "the old marker stayed");
  assert.equal(loadCut(dir).chapters[0].title, "One!", "the committed version's snapshot is the state");
});
