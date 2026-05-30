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

test("POST /api/message logs to the conversation + GET /api/conversation returns it (ADR-0014)", async () => {
  const { base, cleanup } = await boot();
  try {
    const post = await fetch(`${base}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "make the whole page more premium" }),
    });
    assert.equal(post.status, 200);
    const convo = await (await fetch(`${base}/api/conversation`)).json();
    assert.ok(convo.some((m) => m.role === "user" && /premium/.test(m.text)));
  } finally { await cleanup(); }
});

test("POST /api/message with empty text is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    const r = await fetch(`${base}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "  " }),
    });
    assert.equal(r.status, 400);
  } finally { await cleanup(); }
});

test("POST /api/message honors an explicit agent role; unknown roles fall back to user", async () => {
  const { base, cleanup } = await boot();
  try {
    // Supervising agent replies through this lane -> must land as "agent", not "user".
    await fetch(`${base}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "agent", text: "draft is ready" }),
    });
    // A bogus role is sanitized to "user" (value is used as a CSS class suffix).
    await fetch(`${base}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "wi-msg--evil", text: "spoof attempt" }),
    });
    // No role at all -> defaults to "user".
    await fetch(`${base}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "plain user note" }),
    });
    const convo = await (await fetch(`${base}/api/conversation`)).json();
    assert.ok(convo.some((m) => m.role === "agent" && /draft is ready/.test(m.text)), "agent role honored");
    assert.ok(convo.some((m) => m.role === "user" && /spoof attempt/.test(m.text)), "bogus role -> user");
    assert.ok(convo.some((m) => m.role === "user" && /plain user note/.test(m.text)), "missing role -> user");
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

// Download endpoint added 2026-05-28 — POST /api/export now also exposes the file
// over GET /api/export/file/:name with Content-Disposition so the browser actually saves it.
test("POST /api/export returns a download URL + GET /api/export/file serves the bytes", async () => {
  const { base, cleanup } = await boot();
  try {
    // Trigger an HTML export of v0 (the seeded version).
    const post = await fetch(`${base}/api/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, format: "html" }),
    });
    assert.equal(post.status, 200);
    const body = await post.json();
    assert.ok(body.file, "response should include the export filename");
    assert.ok(body.download, "response should include a download URL");
    assert.match(body.download, new RegExp(`/api/export/file/${body.file}$`));

    // Fetch the file via the download URL.
    const dl = await fetch(`${base}${body.download}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition") || "", /attachment;\s*filename="/i);
    const bytes = await dl.text();
    assert.ok(bytes.includes("<html"), "downloaded content should be HTML");
  } finally { await cleanup(); }
});

test("GET /api/export/file rejects path-traversal attempts", async () => {
  const { base, cleanup } = await boot();
  try {
    const bad = await fetch(`${base}/api/export/file/${encodeURIComponent("../_v0.html")}`);
    assert.equal(bad.status, 400);
  } finally { await cleanup(); }
});

// --- Sources + filesystem browse (ADR-0017) ---

const jpost = (base, path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/sources starts empty", async () => {
  const { base, cleanup } = await boot();
  try {
    const r = await (await fetch(`${base}/api/sources`)).json();
    assert.deepEqual(r.sources, []);
  } finally { await cleanup(); }
});

test("POST /api/sources persists, dedupes, and resolves to absolute paths", async () => {
  const { base, dir, cleanup } = await boot();
  try {
    const res = await jpost(base, "/api/sources", { paths: ["/tmp/a.txt", "/tmp/a.txt", "/tmp/b"], note: "use these" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sources.length, 2, "duplicate path is collapsed");
    assert.equal(body.added.length, 2);
    assert.equal(body.sources[0].status, "pending");
    assert.equal(body.sources[0].note, "use these");
    assert.ok(existsSync(join(dir, "requests", "sources.json")), "sources.json written under requests/");

    // Re-posting a known path adds nothing new.
    const again = await (await jpost(base, "/api/sources", { paths: ["/tmp/a.txt"] })).json();
    assert.equal(again.added.length, 0);
    assert.equal(again.sources.length, 2);
  } finally { await cleanup(); }
});

test("POST /api/sources with no paths is rejected", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.equal((await jpost(base, "/api/sources", { paths: [] })).status, 400);
  } finally { await cleanup(); }
});

test("POST /api/sources/status marks a source indexed", async () => {
  const { base, cleanup } = await boot();
  try {
    await jpost(base, "/api/sources", { paths: ["/tmp/data"] });
    const res = await jpost(base, "/api/sources/status", { path: "/tmp/data", status: "indexed" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sources[0].status, "indexed");
    assert.ok(body.sources[0].indexed_at, "indexed_at stamped");
  } finally { await cleanup(); }
});

test("POST /api/sources/status rejects invalid status and unknown paths", async () => {
  const { base, cleanup } = await boot();
  try {
    await jpost(base, "/api/sources", { paths: ["/tmp/data"] });
    assert.equal((await jpost(base, "/api/sources/status", { path: "/tmp/data", status: "bogus" })).status, 400);
    assert.equal((await jpost(base, "/api/sources/status", { path: "/tmp/nope", status: "indexed" })).status, 404);
    assert.equal((await jpost(base, "/api/sources/status", { status: "indexed" })).status, 400);
  } finally { await cleanup(); }
});

test("GET /api/fs lists a directory with absolute paths and a parent", async () => {
  const { base, dir, cleanup } = await boot();
  try {
    const r = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir)}`)).json();
    assert.equal(r.path, dir);
    assert.ok(r.home, "home is reported");
    assert.ok(Array.isArray(r.entries));
    // initWorkspace seeds _v0.html + versions.json — both should appear as files with absolute paths.
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
