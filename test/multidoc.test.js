import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";

// Each boot gets an isolated wicked-bus DB (ADR-0019). bus-client memoizes the handle per
// process and releases it on svc.stop() (closeBus), so a fresh dir per boot = fresh bus.
function freshBus() {
  process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-multi-"));
}

async function boot() {
  freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-multi-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  return { root, svc, base, cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("GET /api/docs returns an empty list on a fresh root", async () => {
  const { base, cleanup } = await boot();
  try {
    const docs = await (await fetch(`${base}/api/docs`)).json();
    assert.deepEqual(docs, []);
  } finally { await cleanup(); }
});

test("POST /api/docs creates a doc + GET lists it + per-doc route works", async () => {
  const { base, root, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "first-doc", html: "<h1>Hello</h1><p>x</p>" }),
    });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).name, "first-doc");
    assert.ok(existsSync(join(root, "first-doc", "versions.json")));

    const list = await (await fetch(`${base}/api/docs`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "first-doc");
    assert.equal(list[0].head, 0);

    // Per-doc endpoint reachable under the prefix:
    const m = await (await fetch(`${base}/d/first-doc/api/versions`)).json();
    assert.equal(m.head, 0);
  } finally { await cleanup(); }
});

test("POST /api/docs validates name + html and reports duplicates", async () => {
  const { base, cleanup } = await boot();
  try {
    const bad = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad Name With Spaces!", html: "<p>x</p>" }),
    });
    // Service slugifies / validates; either accepts the slug or rejects. Accept slugify.
    assert.ok(bad.status === 200 || bad.status === 400);

    const noHtml = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ok", html: "" }),
    });
    assert.equal(noHtml.status, 400);

    await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dupe", html: "<p>x</p>" }),
    });
    const again = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dupe", html: "<p>y</p>" }),
    });
    assert.equal(again.status, 409);
  } finally { await cleanup(); }
});

test("POST /api/docs returns 400 (not a 500 stack) when workspace init throws", async () => {
  const { base, root, cleanup } = await boot();
  try {
    // Plant a FILE where the new doc's directory would be created. initWorkspace's
    // mkdirSync(dir, { recursive: true }) then throws ENOTDIR — the guard must turn that
    // into a clean 400, not an unhandled 500 with a stack trace.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "blocked"), "i am a file, not a directory");
    const res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "blocked", html: "<h1>ok</h1>" }),
    });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error, "400 body carries an error message");
  } finally { await cleanup(); }
});

test("existing docs on disk are mounted on startup", async () => {
  // Pre-create a doc on disk, then boot — it should appear in /api/docs.
  freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-multi-"));
  const { initWorkspace } = await import("../src/service/workspace.js");
  initWorkspace(join(root, "preexisting"), "<h1>seeded</h1>");
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  try {
    const docs = await (await fetch(`http://localhost:${port}/api/docs`)).json();
    assert.ok(docs.some((d) => d.name === "preexisting"));
    const m = await (await fetch(`http://localhost:${port}/d/preexisting/api/versions`)).json();
    assert.equal(m.head, 0);
  } finally { await svc.stop(); rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// "From my content" (kind:source, ADR-0010): the service seeds a placeholder and emits
// wicked.doc.created(kind:source) — the agent builds the first draft. No request file
// (ADR-0019); the doc.created emission is verified in bridge.test.js.
// ---------------------------------------------------------------------------
test("POST /api/docs kind:source seeds a placeholder (agent builds the draft)", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "from-content", kind: "source", source_paths: ["~/notes/q3", "./extra.md"], brief: "6 slides" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "from-content");
    assert.equal(body.head, 0);
    assert.equal(body.generating, true);

    // Placeholder v0 exists and the manifest head is 0 (agent will land v1 later).
    const m = await (await fetch(`${base}/d/from-content/api/versions`)).json();
    assert.equal(m.head, 0);
  } finally { await cleanup(); }
});

test("POST /api/docs kind:source requires source paths or a brief", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-source", kind: "source", source_paths: ["", "  "] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /source path|brief/);
  } finally { await cleanup(); }
});

test("POST /api/docs kind:source accepts a brief with no source paths (brief-only generation)", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "brief-only", kind: "source", brief: "A one-page product teaser" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).generating, true);
  } finally { await cleanup(); }
});
