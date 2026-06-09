// server.test.js — the per-doc sub-app's STATE-PLANE reads + synchronous artifact commands.
// The control-plane intake (feedback/chat/status/sources/demo) moved to the bus and is
// covered by bridge.test.js (round-trip) + handlers.test.js (materialization). createServer
// here gets a spy `emit` so we can assert the facts it announces without opening a bus.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/service/server.js";
import { initWorkspace } from "../src/service/workspace.js";

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "wi-srv-"));
  initWorkspace(dir, "<h1>Q2 Results</h1><p>body</p>");
  const events = [];
  const svc = createServer({ dir, emit: (type, payload) => events.push({ type, payload }) });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  return { dir, svc, base, events, cleanup: async () => { await svc.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("GET /api/versions returns the manifest", async () => {
  const { base, cleanup } = await boot();
  try {
    const m = await (await fetch(`${base}/api/versions`)).json();
    assert.equal(m.head, 0);
    assert.equal(m.versions.length, 1);
  } finally { await cleanup(); }
});

test("GET /doc serves the head HTML with data-wid anchors", async () => {
  const { base, cleanup } = await boot();
  try {
    const html = await (await fetch(`${base}/doc`)).text();
    assert.match(html, /data-wid="slide-0-heading-1"/);
  } finally { await cleanup(); }
});

test("GET /doc/99 for an unknown version is 404", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.equal((await fetch(`${base}/doc/99`)).status, 404);
  } finally { await cleanup(); }
});

test("POST /api/fork creates a follow-on version and announces wicked.version.created", async () => {
  const { base, events, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: 0 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.parent, 0);
    assert.equal(body.version, 1);
    const fact = events.find((e) => e.type === "wicked.version.created");
    assert.ok(fact, "emitted version.created");
    assert.equal(fact.payload.kind, "fork");
    assert.equal(fact.payload.version, 1);
  } finally { await cleanup(); }
});

test("POST /api/fork without a numeric from is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    })).status, 400);
  } finally { await cleanup(); }
});

// Download endpoint (2026-05-28): POST /api/export exposes the file over GET with
// Content-Disposition so the browser actually saves it, and emits wicked.export.requested.
test("POST /api/export returns a download URL + GET /api/export/file serves the bytes", async () => {
  const { base, events, cleanup } = await boot();
  try {
    const post = await fetch(`${base}/api/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, format: "html" }),
    });
    assert.equal(post.status, 200);
    const body = await post.json();
    assert.ok(body.file, "response includes the export filename");
    assert.match(body.download, new RegExp(`/api/export/file/${body.file}$`));
    assert.ok(events.some((e) => e.type === "wicked.export.requested"), "emitted export.requested");

    const dl = await fetch(`${base}${body.download}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") || "", /attachment;\s*filename="/i);
    assert.ok((await dl.text()).includes("<html"), "downloaded content is HTML");
  } finally { await cleanup(); }
});

test("GET /api/export/file rejects path-traversal attempts", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/export/file/${encodeURIComponent("../_v0.html")}`)).status, 400);
  } finally { await cleanup(); }
});

test("GET /api/conversation starts empty", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.deepEqual(await (await fetch(`${base}/api/conversation`)).json(), []);
  } finally { await cleanup(); }
});

// --- Sources GET + filesystem browse (ADR-0017). The POST intake is now a bus event
//     (wicked.source.attached); see handlers.test.js + bridge.test.js. ---

test("GET /api/sources starts empty", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.deepEqual((await (await fetch(`${base}/api/sources`)).json()).sources, []);
  } finally { await cleanup(); }
});

test("GET /api/fs lists a directory with absolute paths and a parent", async () => {
  const { base, dir, cleanup } = await boot();
  try {
    const r = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir)}`)).json();
    assert.equal(r.path, dir);
    assert.ok(r.home, "home reported");
    const seed = r.entries.find((e) => e.name === "_v0.html");
    assert.ok(seed && !seed.dir, "_v0.html present and flagged as a file");
    assert.equal(seed.path, join(dir, "_v0.html"), "entry path is absolute");
  } finally { await cleanup(); }
});

test("GET /api/fs hides dotfiles and 404s on a missing directory", async () => {
  const { base, cleanup } = await boot();
  try {
    const r = await (await fetch(`${base}/api/fs?path=${encodeURIComponent("/")}`)).json();
    assert.ok(!r.entries.some((e) => e.name.startsWith(".")), "dotfiles hidden");
    assert.equal((await fetch(`${base}/api/fs?path=${encodeURIComponent("/no/such/dir/xyz")}`)).status, 404);
  } finally { await cleanup(); }
});
