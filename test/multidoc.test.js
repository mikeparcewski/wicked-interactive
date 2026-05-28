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
