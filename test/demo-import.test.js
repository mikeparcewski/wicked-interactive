// Import a cut from takes recorded elsewhere (a crew demo run's segments, so the run's demo can be edited):
// stage each chapter's bytes, name the chapters, one render; refused once the document has a cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { importCut, importStagePath, probeDuration, stageImport } from "../src/service/demo-cut.js";
import { findFfmpeg } from "../src/service/demo.js";

const NEUTRAL = { palette: { canvas: "#16181d", surface: "#22252c", ink: "#f5f6f8", ink2: "#d4d7dd", muted: "#a2a7b1", line: "#33373f", accent: "#b8bec9", font: "system-ui", scheme: "dark" }, source: "fallback", theme: null };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wi-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, "<main><h1>Demo</h1></main>");
  mkdirSync(join(dir, "recordings"), { recursive: true });
  return dir;
}
// A fake ffmpeg: `-i <file>` reports a 3.5 s duration; an encode writes its output.
function encoder() {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
    if (args.length === 3 && args[1] === "-i") return { status: 1, stderr: "Input #0, mov,mp4:\n  Duration: 00:00:03.50, start: 0.000000, bitrate: 5 kb/s\n  Stream #0:0(und): Video: h264, yuv420p\n" };
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  return { runner, calls };
}

test("a chapter id is a plain slug; staging is atomic and refused once a cut exists", (t) => {
  const dir = fixture(t);
  for (const bad of ["../x", "A", "", "x/y", "-x", "x".repeat(49)]) assert.throws(() => importStagePath(dir, bad), (e) => e.payload.field === "chapter");
  assert.throws(() => stageImport(dir, "one", Buffer.alloc(0)), (e) => e.payload.field === "body");
  assert.deepEqual(stageImport(dir, "one", Buffer.from("video")), { chapter: "one", bytes: 5 });
  assert.equal(readFileSync(importStagePath(dir, "one"), "utf8"), "video");
  assert.ok(!existsSync(`${importStagePath(dir, "one")}.part`));
});

test("the import names staged chapters, makes one take each, renders once, and is refused twice", async (t) => {
  const dir = fixture(t), fake = encoder();
  stageImport(dir, "open", Buffer.from("a"));
  stageImport(dir, "close", Buffer.from("b"));
  const r = await importCut(dir, { title: "Tour", url: "http://127.0.0.1:5173/", chapters: [{ id: "open", title: "Open it", say: "First\nline" }, { id: "close", title: "Close it" }] }, { runner: fake.runner, skin: NEUTRAL });
  assert.equal(r.version, 1);
  const cut = JSON.parse(readFileSync(join(dir, "demo-cut.json"), "utf8"));
  assert.deepEqual(cut.chapters.map((c) => [c.id, c.title, c.take, c.inSec, c.outSec, c.say]), [
    ["open", "Open it", "_take-open-1.mp4", 0, 3.5, "First line"], ["close", "Close it", "_take-close-1.mp4", 0, 3.5, ""]]);
  assert.equal(cut.url, "http://127.0.0.1:5173/");
  assert.equal(cut.style.theme.palette, "skin");
  assert.ok(!existsSync(importStagePath(dir, "open")));
  await assert.rejects(importCut(dir, { chapters: [{ id: "open", title: "x" }] }, { runner: fake.runner }), (e) => e.status === 409 && e.payload.error === "cut_exists");
  assert.throws(() => stageImport(dir, "more", Buffer.from("c")), (e) => e.status === 409);
});

test("the import refuses unknown fields, duplicates, unstaged chapters and a bad title", async (t) => {
  const dir = fixture(t), fake = encoder();
  stageImport(dir, "one", Buffer.from("a"));
  for (const [body, field] of [
    [{ chapters: [{ id: "one", title: "x" }], extra: 1 }, "body.extra"],
    [{ chapters: [] }, "chapters"],
    [{ chapters: [{ id: "one", title: "x" }, { id: "one", title: "y" }] }, "chapters.1.id"],
    [{ chapters: [{ id: "one", title: "line\nbreak" }] }, "chapters.0.title"],
    [{ chapters: [{ id: "one", title: "x", color: "red" }] }, "chapters.0.color"],
  ]) await assert.rejects(importCut(dir, body, { runner: fake.runner }), (e) => e.payload.field === field, JSON.stringify(body));
  await assert.rejects(importCut(dir, { chapters: [{ id: "two", title: "x" }] }, { runner: fake.runner }), (e) => e.status === 409 && e.payload.error === "not_staged");
  assert.ok(existsSync(importStagePath(dir, "one")), "a refused import leaves the staged files");
});

test("a refused or failed import leaves the staged files, so the same POST can be retried", async (t) => {
  const dir = fixture(t);
  stageImport(dir, "open", Buffer.from("a"));
  stageImport(dir, "close", Buffer.from("b"));
  const body = { chapters: [{ id: "open", title: "Open" }, { id: "close", title: "Close" }] };
  // The second chapter is too short: nothing moves.
  const short = (args) => (args[1] === "-i" && args[2].endsWith("_import-close.mp4")
    ? { status: 1, stderr: "  Duration: 00:00:00.20, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0: Video: h264\n" } : encoder().runner(args));
  await assert.rejects(importCut(dir, body, { runner: short, skin: NEUTRAL }), (e) => e.payload.error === "too_short");
  assert.ok(existsSync(importStagePath(dir, "open")) && existsSync(importStagePath(dir, "close")));
  // The encoder fails mid-render: the takes go back to staging, no cut is written.
  const failing = (args) => (args.includes("-filter_complex") ? { status: 1, stderr: "boom" } : encoder().runner(args));
  await assert.rejects(importCut(dir, body, { runner: failing, skin: NEUTRAL }), (e) => e.payload.error === "ffmpeg_failed");
  assert.ok(existsSync(importStagePath(dir, "open")) && existsSync(importStagePath(dir, "close")) && !existsSync(join(dir, "demo-cut.json")));
  // The retry succeeds as it is.
  assert.equal((await importCut(dir, body, { runner: encoder().runner, skin: NEUTRAL })).version, 1);
});

test("only ffmpeg's own duration line counts, never metadata that contains the word; a file with no video stream is not a video", async () => {
  const stderr = "Input #0, mov:\n  Metadata:\n    title           : Duration: 00:00:00.50, start: 0\n  Duration: 00:01:05.25, start: 0.000000, bitrate: 9 kb/s\n  Stream #0:0(und): Video: h264\n";
  assert.equal(await probeDuration(() => ({ status: 1, stderr }), "/x"), 65.25);
  await assert.rejects(probeDuration(() => ({ status: 1, stderr: "  Duration: 00:00:05.00, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0: Audio: aac\n" }), "/x"), (e) => e.payload.error === "not_a_video");
});

test("the upload streams to disk under a cap, one at a time", async (t) => {
  const dir = fixture(t);
  const svc = createServer({ dir, demoCut: { runner: encoder().runner, fetchSkin: async () => NEUTRAL, uploadLimit: 16 } });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  const put = (id, body) => fetch(`http://localhost:${port}/api/demo/import/${id}`, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body });
  assert.equal((await put("one", Buffer.alloc(10))).status, 200);
  const big = await put("two", Buffer.alloc(64));
  assert.equal(big.status, 413);
  assert.ok(!existsSync(importStagePath(dir, "two")) && !existsSync(`${importStagePath(dir, "two")}.part`));
  assert.equal((await put("three", Buffer.alloc(0))).status, 400);
});

test("a duration ffmpeg cannot read is not a video", async () => {
  await assert.rejects(probeDuration(() => ({ status: 1, stderr: "Invalid data found" }), "/x"), (e) => e.payload.error === "not_a_video");
});

const ffmpeg = findFfmpeg();
test("real ffmpeg, through the routes: PUT two segments, POST the import, GET the cut", { skip: !ffmpeg && "ffmpeg unavailable", timeout: 180_000 }, async (t) => {
  const dir = fixture(t);
  const src = mkdtempSync(join(tmpdir(), "wi-import-src-"));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const make = (name, colour, seconds) => {
    const out = join(src, name);
    const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=30:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out);
  };
  const svc = createServer({ dir, demoCut: { ffmpegPath: ffmpeg, fetchSkin: async () => NEUTRAL } });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  const base = `http://localhost:${port}/api/demo`;
  for (const [id, colour, s] of [["start", "red", 2], ["finish", "blue", 3]]) {
    const r = await fetch(`${base}/import/${id}`, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: make(`${id}.mp4`, colour, s) });
    assert.equal(r.status, 200, await r.clone().text());
  }
  assert.equal((await fetch(`${base}/import/..%2Fescape`, { method: "PUT", body: "x" })).status, 400);
  const imp = await fetch(`${base}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Tour", chapters: [{ id: "start", title: "Start" }, { id: "finish", title: "Finish", say: "Done." }] }) });
  assert.equal(imp.status, 200, await imp.clone().text());
  const cut = await (await fetch(`${base}/cut`)).json();
  assert.deepEqual(cut.chapters.map((c) => [c.id, Math.round(c.outSec)]), [["start", 2], ["finish", 3]]);
  assert.equal(cut.skin.source, "fallback");
  assert.ok(existsSync(join(dir, "recordings", `_v${cut.version}.mp4`)));
});
