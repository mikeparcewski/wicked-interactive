import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";

process.env.WICKED_NO_BUS = "1";

async function boot() {
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
// "From my content" (kind:source, ADR-0010): the service seeds a placeholder and
// hands a generation request to the supervising agent — it never generates itself.
// ---------------------------------------------------------------------------
test("POST /api/docs kind:source seeds a placeholder + writes a generation request", async () => {
  const { base, root, cleanup } = await boot();
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

    // The generation request file is on disk for the agent to fulfill.
    const reqPath = join(root, "from-content", "requests", "_gen.request.json");
    assert.ok(existsSync(reqPath), "generation request file written");
    const { readFileSync } = await import("node:fs");
    const reqBody = JSON.parse(readFileSync(reqPath, "utf-8"));
    assert.deepEqual(reqBody.source_paths, ["~/notes/q3", "./extra.md"]);
    assert.equal(reqBody.brief, "6 slides");
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
  const { base, root, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "brief-only", kind: "source", brief: "A one-page product teaser" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generating, true);

    // A generation request is written with the brief and an empty source-path list.
    const { readFileSync } = await import("node:fs");
    const reqPath = join(root, "brief-only", "requests", "_gen.request.json");
    assert.ok(existsSync(reqPath), "generation request file written");
    const reqBody = JSON.parse(readFileSync(reqPath, "utf-8"));
    assert.deepEqual(reqBody.source_paths, []);
    assert.equal(reqBody.brief, "A one-page product teaser");
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Cross-doc event multiplexer: /api/events/all (operator-facing tail). Added
// in the watcher follow-up so a single listener can survive doc creation +
// catch every per-doc broadcast without polling each /d/:doc/events stream.
// ---------------------------------------------------------------------------
test("GET /api/events/all multiplexes per-doc broadcasts with the doc name", async () => {
  const { base, cleanup } = await boot();
  try {
    // Create a doc first so its sub-server is mounted with the tap wired.
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tap-doc", html: "<h1>Tap</h1><p>x</p>" }),
    });
    assert.equal(create.status, 200);

    // Open the multiplexed SSE stream and collect at least one non-ready frame.
    const events = [];
    const res = await fetch(`${base}/api/events/all`);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const collect = (async () => {
      while (events.length < 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = "?", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) ev = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (ev !== "ready") events.push({ ev, data: JSON.parse(data) });
        }
      }
    })();

    // Trigger a status broadcast on the doc — the tap should fan it out to /api/events/all.
    await fetch(`${base}/d/tap-doc/api/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "processing", message: "hello" }),
    });

    await Promise.race([collect, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000))]);

    assert.equal(events.length >= 1, true, "expected at least one multiplexed event");
    const e = events[0];
    assert.equal(e.ev, "status");
    assert.equal(e.data.doc, "tap-doc", "doc name should be prepended to the payload");
    assert.equal(e.data.message, "hello");

    reader.cancel();
  } finally { await cleanup(); }
});
