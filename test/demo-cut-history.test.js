// A cut's history survives a reload, and an earlier version can be restored (wicked-studio plugins S4, G7 piece 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest, rethemeHead } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { exportGif } from "../src/service/demo.js";
import { defaultStyle, renderCut, loadCut, loadCutVersion, restoreCut, cutSnapshotFile } from "../src/service/demo-cut.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wi-cut-hist-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, "<h1>Tour</h1>", { kind: "demo" });
  mkdirSync(join(dir, "recordings"));
  for (const f of ["_take-one-1.mp4", "_take-two-1.mp4"]) writeFileSync(join(dir, "recordings", f), "take");
  return dir;
}
function cut() {
  return { rev: 0, version: null, url: "http://127.0.0.1:7721/apps/x", chapters: [
    { id: "one", title: "One", say: "First", take: "_take-one-1.mp4", inSec: 0, outSec: 4 },
    { id: "two", title: "Two", say: "Second", take: "_take-two-1.mp4", inSec: 0, outSec: 3 },
  ], takes: {
    one: [{ file: "_take-one-1.mp4", durationSec: 4, at: "2026-11-07T00:00:00Z" }],
    two: [{ file: "_take-two-1.mp4", durationSec: 3, at: "2026-11-07T00:00:00Z" }],
  }, style: defaultStyle("Tour") };
}
const runner = (args) => {
  if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
  writeFileSync(args.at(-1), "encoded");
  return { status: 0, stderr: "" };
};
const opts = { runner, skin: null, fetchSkin: async () => null };

test("every render keeps its cut beside it; an older version reads back after the head moved", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  const renamed = { ...loadCut(dir), chapters: loadCut(dir).chapters.map((c) => (c.id === "one" ? { ...c, title: "Renamed", outSec: 2 } : c)) };
  const v2 = await renderCut(dir, renamed, opts);
  assert.ok(existsSync(join(dir, cutSnapshotFile(v1.version))));
  assert.ok(existsSync(join(dir, cutSnapshotFile(v2.version))));
  const old = loadCutVersion(dir, v1.version);
  assert.equal(old.chapters[0].title, "One");
  assert.equal(old.chapters[0].outSec, 4);
  assert.equal(loadCutVersion(dir, v2.version).chapters[0].title, "Renamed");
  assert.throws(() => loadCutVersion(dir, 0), (e) => e.status === 404 && e.payload.error === "no_snapshot");
});

test("restore renders the old chapters and style as a new version, records where it came from, and keeps the history", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  const head = loadCut(dir);
  const v2 = await renderCut(dir, { ...head, chapters: head.chapters.map((c) => (c.id === "one" ? { ...c, title: "Renamed", outSec: 2 } : c)),
    style: { ...head.style, captions: { ...head.style.captions, position: "top" } } }, opts);
  const r = await restoreCut(dir, { rev: loadCut(dir).rev, from: v1.version }, opts);
  assert.equal(r.parent, v2.version);
  assert.ok(r.version > v2.version);
  const now = loadCut(dir);
  assert.equal(now.version, r.version);
  assert.equal(now.chapters[0].title, "One");
  assert.equal(now.chapters[0].outSec, 4);
  assert.equal(now.style.captions.position, "bottom");
  const entry = loadManifest(dir).versions.find((v) => v.version === r.version);
  assert.equal(entry.restored_from, v1.version);
  assert.equal(entry.parent, v2.version);
  // v2 is still there to come back to.
  assert.equal(loadCutVersion(dir, v2.version).chapters[0].title, "Renamed");
});

test("restore refuses a moved cut, the head itself, a version with no kept cut, and a take that is gone", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  await renderCut(dir, { ...loadCut(dir), chapters: loadCut(dir).chapters.map((c) => ({ ...c, outSec: c.outSec - 1 })) }, opts);
  const { rev, version } = loadCut(dir);
  await assert.rejects(restoreCut(dir, { rev: rev - 1, from: v1.version }, opts), (e) => e.status === 409 && e.payload.error === "rev_moved");
  await assert.rejects(restoreCut(dir, { rev, from: version }, opts), (e) => e.status === 400 && e.payload.field === "from");
  await assert.rejects(restoreCut(dir, { rev, from: 0 }, opts), (e) => e.status === 404 && e.payload.error === "no_snapshot");
  await assert.rejects(restoreCut(dir, { rev, from: v1.version, extra: 1 }, opts), (e) => e.status === 400 && e.payload.field === "body.extra");
  await assert.rejects(restoreCut(dir, { rev, from: v1.version, expect_head: "2" }, opts), (e) => e.status === 400 && e.payload.field === "expect_head");
  rmSync(join(dir, "recordings", "_take-two-1.mp4"));
  await assert.rejects(restoreCut(dir, { rev, from: v1.version }, opts), (e) => e.status === 409 && e.payload.error === "take_missing" && e.payload.field === "chapters.1.take");
  assert.equal(loadCut(dir).version, version, "nothing landed");
});

test("restore keeps takes a re-authored full take dropped from the list", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  // A full take of a re-authored spec starts a new takes list (extractTakes); the old files stay on disk.
  writeFileSync(join(dir, "recordings", "_take-three-1.mp4"), "take");
  await renderCut(dir, { ...loadCut(dir), chapters: [{ id: "three", title: "Three", say: "", take: "_take-three-1.mp4", inSec: 0, outSec: 2 }],
    takes: { three: [{ file: "_take-three-1.mp4", durationSec: 2, at: "2026-11-07T00:00:01Z" }] } }, opts);
  await restoreCut(dir, { rev: loadCut(dir).rev, from: v1.version }, opts);
  const now = loadCut(dir);
  assert.deepEqual(now.chapters.map((c) => c.id), ["one", "two"]);
  assert.deepEqual(Object.keys(now.takes).sort(), ["one", "three", "two"]);
});

test("routes: GET cut?version, POST restore, and a fork of a cut document is refused", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  await renderCut(dir, { ...loadCut(dir), chapters: loadCut(dir).chapters.map((c) => (c.id === "two" ? { ...c, title: "Second" } : c)) }, opts);
  const svc = createServer({ dir, documentId: "tour", demoCut: { runner, fetchSkin: async () => null } });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const req = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const old = await req("GET", `/api/demo/cut?version=${v1.version}`);
  assert.equal(old.status, 200);
  assert.equal(old.body.version, v1.version);
  assert.equal(old.body.chapters[1].title, "Two");
  assert.ok(old.body.style && old.body.ffmpeg, "the same shape as the head read");
  assert.equal((await req("GET", "/api/demo/cut?version=0")).status, 404);
  assert.equal((await req("GET", "/api/demo/cut?version=x")).body.field, "version");
  const head = await req("GET", "/api/demo/cut");
  const restored = await req("POST", "/api/demo/restore", { rev: head.body.rev, from: v1.version });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.parent, head.body.version);
  assert.equal((await req("GET", "/api/demo/cut")).body.chapters[1].title, "Two");
  assert.deepEqual(await req("POST", "/api/demo/restore", { rev: head.body.rev, from: v1.version }), { status: 409, body: { error: "rev_moved", rev: head.body.rev + 1 } });
  const fork = await req("POST", "/api/fork", { from: v1.version });
  assert.equal(fork.status, 409);
  assert.equal(fork.body.error, "cut_restore");
  assert.equal(loadManifest(dir).head, restored.body.version, "the fork moved nothing");
});

test("a cut version's GIF is made from its MP4 (a re-cut lands no WebM)", async (t) => {
  const dir = fixture(t);
  const v = await renderCut(dir, cut(), opts);
  let source = null;
  const out = exportGif(dir, v.version, { encoder: (src, gif) => { source = src; writeFileSync(gif, "GIF89a"); } });
  assert.equal(source, join(dir, "recordings", `_v${v.version}.mp4`));
  assert.equal(out.path, join(dir, "recordings", `_v${v.version}.gif`));
  assert.ok(readFileSync(join(dir, "recordings", `_v${v.version}-poster.jpg`), "utf8").length > 0, "every render writes the poster");
});

test("restore with expect_head refuses when a page version landed on the cut document since", async (t) => {
  const dir = fixture(t);
  const v1 = await renderCut(dir, cut(), opts);
  const v2 = await renderCut(dir, { ...loadCut(dir), chapters: loadCut(dir).chapters.map((c) => ({ ...c, outSec: c.outSec - 1 })) }, opts);
  // A page version (a re-theme) moves the document head without touching the cut's rev.
  const themed = rethemeHead(dir, { colors: { primary: "#123456" } });
  assert.ok(themed.version > v2.version, "the head moved past the cut");
  const { rev } = loadCut(dir);
  await assert.rejects(restoreCut(dir, { rev, from: v1.version, expect_head: v2.version }, opts), (e) => e.status === 409 && e.payload.error === "head_moved" && e.payload.head === themed.version);
  assert.equal(loadManifest(dir).head, themed.version, "nothing landed");
  const ok = await restoreCut(dir, { rev, from: v1.version, expect_head: themed.version }, opts);
  assert.equal(ok.parent, themed.version);
});

test("the GIF route answers the file name studio links to", async (t) => {
  const dir = fixture(t);
  const v = await renderCut(dir, cut(), opts);
  // The route encodes with the real encoder; a GIF already cached for the version is served as is.
  writeFileSync(join(dir, "recordings", `_v${v.version}.gif`), "GIF89a");
  const svc = createServer({ dir, documentId: "tour", demoCut: { runner, fetchSkin: async () => null } });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  const r = await fetch(`http://localhost:${port}/api/demo/gif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: v.version }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.file, `_v${v.version}.gif`);
  assert.equal(body.cached, true);
});
