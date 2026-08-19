// shell-retirement.test.js — the bridge is API-only (DES-MERGE-001 §6.4 slice 18, §7.13).
// GET / redirects to the studio origin recorded in .wi-serve.json; with none recorded it
// explains itself in plain HTML (never a bare 404); --standalone keeps the retired SPA shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";
import { writeLock, readStudioOrigin } from "../src/service/serve-bridge.mjs";
import { writeBreadcrumb } from "../src/service/project.js";

// Isolated bus per boot (same contract as multidoc.test.js): bus-client memoizes per process
// and releases on svc.stop(), so a fresh data dir per boot = a fresh bus.
function freshBus() {
  process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-shell-"));
}

async function boot({ standalone, frontendDir } = {}) {
  freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-shell-"));
  const svc = createMultiServer({ root, standalone, frontendDir });
  const port = await svc.start(0);
  return {
    root, svc, base: `http://localhost:${port}`,
    cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

// A lockfile is what the bridge itself writes on start; tests that need one stand it in.
const seedLock = (root, extra = {}) => writeLock(root, { port: 4400, host: "127.0.0.1", pid: process.pid, ...extra });

const createDoc = (base, body) => fetch(`${base}/api/docs`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("GET / with NO studio origin recorded: an informative page, not a 404", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.match(html, /API/, "names what this port is");
    assert.match(html, /wicked-studio/, "names where the UI went");
    assert.match(html, /--standalone/, "names the escape hatch");
    assert.match(html, /\.wi-serve\.json/, "names where the origin is recorded");
  } finally { await cleanup(); }
});

test("GET / redirects to the recorded studio origin (302, uncached)", async () => {
  const { base, root, cleanup } = await boot();
  try {
    seedLock(root, { studio_origin: "http://localhost:4200" });
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "http://localhost:4200/");
    assert.match(res.headers.get("cache-control") || "", /no-store/, "a moved origin must not be cached");
  } finally { await cleanup(); }
});

test("GET /?doc=<bound doc> lands on that doc's studio route; unbound/unknown land on the board", async () => {
  const { base, root, cleanup } = await boot();
  try {
    seedLock(root, { studio_origin: "http://localhost:4200/" });
    assert.equal((await createDoc(base, { name: "bound-doc", html: "<h1>a</h1>" })).status, 200);
    assert.equal((await createDoc(base, { name: "loose-doc", html: "<h1>b</h1>" })).status, 200);
    writeBreadcrumb(join(root, "bound-doc"), { project_id: "proj-7" });

    const bound = await fetch(`${base}/?doc=bound-doc`, { redirect: "manual" });
    assert.equal(bound.headers.get("location"), "http://localhost:4200/p/proj-7/document/bound-doc");

    for (const q of ["?doc=loose-doc", "?doc=no-such-doc", "?doc=../etc/passwd", ""]) {
      const res = await fetch(`${base}/${q}`, { redirect: "manual" });
      assert.equal(res.headers.get("location"), "http://localhost:4200/", `${q || "(no query)"} → board`);
    }
  } finally { await cleanup(); }
});

test("a garbage studio_origin is ignored — the page, not a broken redirect", async () => {
  const { base, root, cleanup } = await boot();
  try {
    seedLock(root, { studio_origin: "file:///etc/passwd" });
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /wicked-studio/);
  } finally { await cleanup(); }
});

test("POST /api/studio-origin records it (crew's start/adopt path) and GET reads it back", async () => {
  const { base, root, cleanup } = await boot();
  try {
    seedLock(root);
    assert.deepEqual(await (await fetch(`${base}/api/studio-origin`)).json(), { studio_origin: null });

    const post = (origin) => fetch(`${base}/api/studio-origin`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin }),
    });
    const ok = await post("http://127.0.0.1:4200/runs/42");   // path stripped: an ORIGIN is recorded
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, studio_origin: "http://127.0.0.1:4200" });
    assert.equal(readStudioOrigin(root), "http://127.0.0.1:4200");
    assert.deepEqual(await (await fetch(`${base}/api/studio-origin`)).json(), { studio_origin: "http://127.0.0.1:4200" });

    // ...and the redirect follows it immediately — adoption needs no restart.
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.headers.get("location"), "http://127.0.0.1:4200/");

    assert.equal((await post("not-a-url")).status, 400);
    assert.equal((await post("ftp://elsewhere/")).status, 400);
    assert.equal(readStudioOrigin(root), "http://127.0.0.1:4200", "a refused origin never overwrites the good one");
  } finally { await cleanup(); }
});

test("POST /api/studio-origin with no lockfile to record into is a 409, not a silent success", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await fetch(`${base}/api/studio-origin`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "http://localhost:4200" }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /\.wi-serve\.json/);
  } finally { await cleanup(); }
});

test("--standalone still serves the retired shell at / (development escape hatch)", async () => {
  const dist = mkdtempSync(join(tmpdir(), "wi-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=\"root\">SHELL</div>");
  const { base, root, cleanup } = await boot({ standalone: true, frontendDir: dist });
  try {
    seedLock(root, { studio_origin: "http://localhost:4200" }); // present, and deliberately not honored
    const res = await fetch(base, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /SHELL/);
  } finally { await cleanup(); rmSync(dist, { recursive: true, force: true }); }
});

test("WI_STANDALONE=1 is the same escape hatch as the flag", async () => {
  const dist = mkdtempSync(join(tmpdir(), "wi-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><div id=\"root\">SHELL</div>");
  const prior = process.env.WI_STANDALONE;
  process.env.WI_STANDALONE = "1";
  const { base, cleanup } = await boot({ frontendDir: dist });   // no explicit flag — env decides
  try {
    assert.match(await (await fetch(base)).text(), /SHELL/);
  } finally {
    await cleanup();
    rmSync(dist, { recursive: true, force: true });
    if (prior === undefined) delete process.env.WI_STANDALONE; else process.env.WI_STANDALONE = prior;
  }
});

test("API-only mode serves no shell under /d/<doc> either", async () => {
  const { base, cleanup } = await boot();
  try {
    assert.equal((await createDoc(base, { name: "quiet-doc", html: "<h1>a</h1>" })).status, 200);
    assert.equal((await fetch(`${base}/d/quiet-doc/`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${base}/d/quiet-doc/index.html`, { redirect: "manual" })).status, 404);
    // ...while the doc's own API surface is untouched.
    assert.equal((await fetch(`${base}/d/quiet-doc/api/versions`)).status, 200);
  } finally { await cleanup(); }
});
