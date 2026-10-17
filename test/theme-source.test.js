// theme-source.test.js — PUT /d/:doc/api/theme/source (studio, operator 2026-10-17: "it's impossible to guess
// what paths it would take but it could be an upload or select file").
//
// A learn from a PDF or an image used to need a path typed by hand. The operator now chooses the file in studio
// and its bytes ride a raw body to the document's theme dir; the answer is only the path the learn then names
// (`theme.requested {path}`), so the materializer reads it in place exactly as before. Pinned here: the accepted
// types and their first bytes, the size cap, the one-at-a-time rule, where the file lands, and that the path it
// answers is one `materializeThemeRequested` takes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";
import { materializeThemeRequested } from "../src/service/handlers.js";

function freshBus() {
  const dir = mkdtempSync(join(tmpdir(), "wi-bus-source-"));
  process.env.WICKED_BUS_DATA_DIR = dir;
  return dir;
}

async function boot() {
  const busDir = freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-source-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  const res = await fetch(`${base}/api/docs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "brand", html: "<h1>x</h1>" }) });
  assert.equal(res.status, 200);
  return { root, base, cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); rmSync(busDir, { recursive: true, force: true }); } };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = Buffer.from("%PDF-1.4\n%fixture\n");
const put = (base, body, type) => fetch(`${base}/d/brand/api/theme/source`, { method: "PUT", headers: { "Content-Type": type }, body });

test("a PNG lands in the doc's theme dir and the answer names it; the learn takes that path", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await put(base, PNG, "image/png");
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.document_id, "brand");
    assert.equal(out.format, "image");
    assert.equal(out.bytes, PNG.length);
    assert.equal(basename(dirname(out.path)), "theme");
    assert.match(basename(out.path), /^source_\d+_[0-9a-f]{8}\.png$/);
    assert.deepEqual(readFileSync(out.path), PNG);
    // The materializer reads it in place, as it reads a path typed by hand.
    const emitted = [];
    const r = await materializeThemeRequested(dirname(dirname(out.path)), { path: out.path }, { emit: (t, p) => emitted.push([t, p]) });
    assert.equal(r.render_path, out.path);
    assert.equal(r.format, "image");
    assert.equal(emitted[0][0], "wicked.interactive.theme.learned");
  } finally { await cleanup(); }
});

test("a PDF is a pdf source", async () => {
  const { base, cleanup } = await boot();
  try {
    const res = await put(base, PDF, "application/pdf");
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.format, "pdf");
    assert.match(out.path, /\.pdf$/);
    assert.ok(existsSync(out.path));
  } finally { await cleanup(); }
});

test("only an image or a PDF, and only when its first bytes say so", async () => {
  const { base, cleanup } = await boot();
  try {
    const html = await put(base, Buffer.from("<svg onload=alert(1)>"), "image/svg+xml");
    assert.equal(html.status, 415);
    assert.equal((await html.json()).error, "unsupported_type");
    const lie = await put(base, Buffer.from("not a png at all"), "image/png");
    assert.equal(lie.status, 415);
    assert.equal((await lie.json()).error, "content_mismatch");
    const empty = await put(base, Buffer.alloc(0), "image/png");
    assert.equal(empty.status, 400);
    // An inherited key is no type (codex r1: `constructor` reached `kind.magic` and threw outside the handler).
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      const r = await put(base, PNG, inherited);
      assert.equal(r.status, 415, inherited);
    }
    assert.equal((await put(base, PNG, "image/png")).status, 200);
  } finally { await cleanup(); }
});

test("over 20 MB is refused and nothing is written", async () => {
  const { base, root, cleanup } = await boot();
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    const res = await put(base, big, "image/png");
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error, "too_large");
    assert.equal(existsSync(join(root, "brand", "theme")), false);
  } finally { await cleanup(); }
});

test("a body that crosses the cap mid-stream (no length declared) still gets its 413, and the next upload is taken", async () => {
  const { base, root, cleanup } = await boot();
  try {
    const { request } = await import("node:http");
    const port = Number(new URL(base).port);
    const status = await new Promise((resolve, reject) => {
      const req = request({ host: "localhost", port, method: "PUT", path: "/d/brand/api/theme/source", headers: { "Content-Type": "image/png" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      let i = 0;
      const tick = () => { if (i++ < 22) { req.write(i === 1 ? PNG : Buffer.alloc(1024 * 1024)); setImmediate(tick); } else req.end(); };
      tick();
    });
    assert.equal(status, 413);
    assert.equal(existsSync(join(root, "brand", "theme")), false);
    assert.equal((await put(base, PNG, "image/png")).status, 200);
  } finally { await cleanup(); }
});
