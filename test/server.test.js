import { test } from "node:test";
import assert from "node:assert/strict";

// Keep the suite side-effect-free: the regen pipeline must not spawn real bus processes.
process.env.WICKED_NO_BUS = "1";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/service/server.js";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";

// Boot the real HTTP server (watch disabled — the chokidar pipeline is covered
// deterministically in workspace.test.js; full e2e is the acceptance test, task #7).
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "wi-srv-"));
  initWorkspace(dir, "<h1>Q2 Results</h1><p>body</p>");
  const svc = createServer({ dir, watch: false });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  return { dir, svc, base, cleanup: async () => { await svc.stop(); rmSync(dir, { recursive: true, force: true }); } };
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
    const res = await fetch(`${base}/doc/99`);
    assert.equal(res.status, 404);
  } finally { await cleanup(); }
});

test("POST /api/feedback writes a versioned feedback file (single writer)", async () => {
  const { base, dir, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, 1);
    assert.equal(body.file, "_v1.md");
    assert.ok(existsSync(join(dir, "_v1.md")), "service wrote the feedback file");
  } finally { await cleanup(); }
});

test("POST /api/feedback with no items is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    assert.equal(res.status, 400);
  } finally { await cleanup(); }
});

test("POST /api/feedback with an invalid item type is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ selector: "x", type: "teleport" }] }),
    });
    assert.equal(res.status, 400);
  } finally { await cleanup(); }
});

test("POST /api/status accepts an agent progress/question post (ADR-0012)", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "processing", message: "reworking the hero", version: 5 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally { await cleanup(); }
});

test("POST /api/answer writes an answer file the agent can read", async () => {
  const { base, dir, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "_v5", answer: "lighter background" }),
    });
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(dir, "requests", "_v5.answer.json")));
    const saved = JSON.parse(readFileSync(join(dir, "requests", "_v5.answer.json"), "utf-8"));
    assert.equal(saved.answer, "lighter background");
  } finally { await cleanup(); }
});

test("POST /api/answer without requestId is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "x" }),
    });
    assert.equal(res.status, 400);
  } finally { await cleanup(); }
});

// Regression guard: the chokidar watcher must actually process a posted feedback file
// (chokidar v4 dropped glob support — watching a glob silently matched nothing).
test("watcher processes posted feedback end-to-end (live loop)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-watch-"));
  initWorkspace(dir, "<h1>Q2 Results</h1><p>body</p>");
  const svc = createServer({ dir, watch: true });
  const port = await svc.start(0);
  try {
    await fetch(`http://localhost:${port}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
      }),
    });
    const t0 = Date.now();
    while (loadManifest(dir).head !== 1 && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(loadManifest(dir).head, 1, "watcher advanced the manifest");
    assert.ok(existsSync(join(dir, "_v1.html")), "watcher produced _v1.html");
  } finally {
    await svc.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
