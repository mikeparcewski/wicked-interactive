import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, processFeedbackFile, forkVersion, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";

process.env.WICKED_NO_BUS = "1";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wi-qf-"));
  initWorkspace(dir, "<h1>Title</h1><p>body</p>");
  return dir;
}

test("rapid writeFeedback reserves distinct version numbers (no _v1 collision)", () => {
  const dir = fresh();
  try {
    const a = writeFeedback(dir, { items: [{ selector: "slide-0-heading-1", type: "content-edit", value: "A" }] });
    const b = writeFeedback(dir, { items: [{ selector: "slide-0-paragraph-1", type: "content-edit", value: "B" }] });
    assert.equal(a.version, 1);
    assert.equal(b.version, 2, "second write must not collide on _v1");
    assert.ok(existsSync(join(dir, "_v1.md")) && existsSync(join(dir, "_v2.md")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forkVersion copies content non-destructively and advances head (AC-21/22)", () => {
  const dir = fresh();
  try {
    const { version, parent } = forkVersion(dir, 0);
    assert.equal(parent, 0);
    assert.equal(loadManifest(dir).head, version);
    assert.equal(readVersionHtml(dir, version), readVersionHtml(dir, 0), "fork copies the source content");
    // original still present:
    assert.ok(existsSync(join(dir, "_v0.html")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forkVersion from a non-existent version throws", () => {
  const dir = fresh();
  try {
    assert.throws(() => forkVersion(dir, 99), /does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/fork creates a follow-on version", async () => {
  const dir = fresh();
  const svc = createServer({ dir, watch: false });
  const port = await svc.start(0);
  try {
    const res = await fetch(`http://localhost:${port}/api/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: 0 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.parent, 0);
    assert.equal(loadManifest(dir).head, body.version);
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("FIFO queue: two rapid UPDATEs both process without racing the manifest", async () => {
  const dir = fresh();
  // watch:false — drive processing through the server's own FIFO (svc.enqueue) instead of
  // waiting on chokidar, which starves under full-suite load and made this flaky (issue #4).
  // This still exercises the real guarantee: two concurrent regenerations dispatched at once
  // must be serialized by the queue so they never race the manifest read-modify-write.
  const svc = createServer({ dir, watch: false });
  const port = await svc.start(0);
  try {
    const post = (sel, val) => fetch(`http://localhost:${port}/api/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ selector: sel, type: "content-edit", value: val }] }),
    });
    // Two rapid UPDATEs reserve distinct feedback files (_v1.md, _v2.md) via the single writer.
    await Promise.all([post("slide-0-paragraph-1", "P-EDIT"), post("slide-0-heading-1", "H-EDIT")]);
    // Dispatch both regenerations through the FIFO at once — the queue serializes them.
    await Promise.all([
      svc.enqueue(() => processFeedbackFile(dir, "_v1.md", { documentId: "doc" })),
      svc.enqueue(() => processFeedbackFile(dir, "_v2.md", { documentId: "doc" })),
    ]);
    const m = loadManifest(dir);
    assert.equal(m.head, 2, "both batches produced versions, serialized");
    assert.ok(existsSync(join(dir, "_v1.html")) && existsSync(join(dir, "_v2.html")));
    assert.equal(new Set(m.versions.map((v) => v.version)).size, m.versions.length, "no duplicate version numbers");
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
