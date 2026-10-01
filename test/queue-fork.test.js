import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, forkVersion, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";

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
  const svc = createServer({ dir });
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

test("FIFO queue: two rapid feedback commands both process without racing the manifest", async () => {
  const dir = fresh();
  // Drive two feedback.submitted commands through the per-doc FIFO (svc.runCommand) at once.
  // The real guarantee: each command's writeFeedback + apply is serialized, so the two never
  // race the manifest read-modify-write and version numbers stay distinct (ADR-0007).
  const svc = createServer({ dir });
  try {
    const cmd = (sel, val) => svc.runCommand({
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "doc", items: [{ selector: sel, type: "content-edit", value: val }] },
    });
    await Promise.all([cmd("slide-0-paragraph-1", "P-EDIT"), cmd("slide-0-heading-1", "H-EDIT")]);
    const m = loadManifest(dir);
    assert.equal(m.head, 2, "both batches produced versions, serialized");
    assert.ok(existsSync(join(dir, "_v1.html")) && existsSync(join(dir, "_v2.html")));
    assert.equal(new Set(m.versions.map((v) => v.version)).size, m.versions.length, "no duplicate version numbers");
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ── C5: optional expect_head guard on fork ────────────────────────────────
const forkEvents = (events) => events.filter((e) => e.type === "wicked.interactive.version.created" && e.payload.kind === "fork");
const capture = () => { const events = []; return { events, emit: (type, payload) => events.push({ type, payload }) }; };
const postFork = (port, body) => fetch(`http://localhost:${port}/api/fork`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("POST /api/fork with a matching expect_head forks as today", async () => {
  const dir = fresh();
  const cap = capture();
  const svc = createServer({ dir, emit: cap.emit });
  const port = await svc.start(0);
  try {
    forkVersion(dir, 0); // head = 1
    const res = await postFork(port, { from: 0, expect_head: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { version: 2, parent: 0 });
    assert.equal(loadManifest(dir).head, 2);
    assert.equal(forkEvents(cap.events).length, 1, "a guarded fork that passes still announces its version");
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/fork with a stale expect_head answers 409 head_moved and creates no version", async () => {
  const dir = fresh();
  const cap = capture();
  const svc = createServer({ dir, emit: cap.emit });
  const port = await svc.start(0);
  try {
    forkVersion(dir, 0); // head = 1 (an agent landed a version)
    const before = loadManifest(dir);
    const res = await postFork(port, { from: 0, expect_head: 0 });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "head_moved", head: 1 });
    const after = loadManifest(dir);
    assert.equal(after.head, 1);
    assert.equal(after.versions.length, before.versions.length, "no version created");
    assert.ok(!existsSync(join(dir, "_v2.html")));
    assert.equal(forkEvents(cap.events).length, 0, "a refused fork announces no version");
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/fork rejects a non-integer expect_head with 400", async () => {
  const dir = fresh();
  const cap = capture();
  const svc = createServer({ dir, emit: cap.emit });
  const port = await svc.start(0);
  try {
    const res = await postFork(port, { from: 0, expect_head: "latest" });
    assert.equal(res.status, 400);
    assert.equal(loadManifest(dir).head, 0);
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("expect_head is checked inside enqueue: a version queued ahead of the fork makes it 409", async () => {
  const dir = fresh();
  const cap = capture();
  const svc = createServer({ dir, emit: cap.emit });
  const port = await svc.start(0);
  try {
    // The head is 0 when both requests are sent; the feedback command is queued first and lands v1,
    // so a check made before enqueue would pass and bury v1. Inside enqueue it sees head 1.
    const feedback = svc.runCommand({
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "doc", items: [{ selector: "slide-0-heading-1", type: "content-edit", value: "AGENT" }] },
    });
    const fork = postFork(port, { from: 0, expect_head: 0 });
    const [, res] = await Promise.all([feedback, fork]);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "head_moved", head: 1 });
    assert.equal(loadManifest(dir).head, 1, "the agent's version stays head; nothing buried");
    assert.equal(forkEvents(cap.events).length, 0, "a refused fork announces no version");
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});
