// theme-readback.test.js — GET /d/:doc/api/theme/learned (#180).
//
// The learn pipeline writes <doc>/theme/learned.theme.json (agent, assist Step 8.5) and the
// version-creation seam applies it silently — this route is the one READ surface for "what did
// the learn produce?", the wire studio's brand-learn accent mapper rides (studio#73 retraction).
// Contract pinned here: 404 (sibling error shape) until a learn completes; afterwards a JSON
// envelope { document_id, learned_at, tokens } where `tokens` is the file's token object verbatim
// and `learned_at` is the file's mtime. A corrupt file reads as 404 — the same "absent" the apply
// seam degrades to, so readback never claims a palette the seam would not apply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";

// Each boot gets an isolated wicked-bus DB (ADR-0019), same pattern as api-parity.test.js —
// including removing the bus dir on cleanup so runs leave no temp residue behind.
function freshBus() {
  const dir = mkdtempSync(join(tmpdir(), "wi-bus-readback-"));
  process.env.WICKED_BUS_DATA_DIR = dir;
  return dir;
}

async function boot() {
  const busDir = freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-readback-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  return {
    root, svc, base,
    cleanup: async () => {
      await svc.stop();
      rmSync(root, { recursive: true, force: true });
      rmSync(busDir, { recursive: true, force: true });
    },
  };
}

async function createDoc(base, name) {
  const res = await fetch(`${base}/api/docs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, html: "<h1>Hello</h1><p>x</p>" }),
  });
  assert.equal(res.status, 200);
}

// A learned token object in the src/themes/*.json shape the agent synthesizes (assist Step 8.5).
const LEARNED = {
  name: "acme-learned",
  colors: { background: "#0B1020", surface: "#141B33", primary: "#8FB4FF", text_primary: "#E6E9F5" },
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
};

test("no learn yet → clean 404 in the sibling JSON error shape", async () => {
  const { base, cleanup } = await boot();
  try {
    await createDoc(base, "fresh-doc");
    const res = await fetch(`${base}/d/fresh-doc/api/theme/learned`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await res.json(), { error: "no learned theme" });
  } finally { await cleanup(); }
});

test("after a (fixtured) learn → the learned tokens come back verbatim with envelope metadata", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "branded-doc");
    // Fixture the learn's durable output exactly where the agent writes it (assist Step 8.5).
    const themeDir = join(root, "branded-doc", "theme");
    mkdirSync(themeDir, { recursive: true });
    const file = join(themeDir, "learned.theme.json");
    writeFileSync(file, JSON.stringify(LEARNED));

    const res = await fetch(`${base}/d/branded-doc/api/theme/learned`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.match(res.headers.get("cache-control") || "", /no-store/, "polled right after a learn — never cached");
    const body = await res.json();
    assert.equal(body.document_id, "branded-doc");
    assert.deepEqual(body.tokens, LEARNED, "the file's token object, verbatim");
    assert.equal(body.learned_at, statSync(file).mtime.toISOString(), "learned_at is the file's mtime");

    // Read-only + current-content: a re-learn (overwrite) is served immediately, no caching.
    const relearned = { ...LEARNED, name: "acme-relearned" };
    writeFileSync(file, JSON.stringify(relearned));
    const again = await (await fetch(`${base}/d/branded-doc/api/theme/learned`)).json();
    assert.equal(again.tokens.name, "acme-relearned");
  } finally { await cleanup(); }
});

test("a corrupt learned file reads as 404 — the same 'absent' the apply seam degrades to", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "corrupt-doc");
    const themeDir = join(root, "corrupt-doc", "theme");
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, "learned.theme.json"), "{not json");
    const res = await fetch(`${base}/d/corrupt-doc/api/theme/learned`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no learned theme" });
  } finally { await cleanup(); }
});

test("unknown doc behaves exactly like the sibling per-doc routes", async () => {
  const { base, cleanup } = await boot();
  try {
    // No doc mounted at /d/nope — both routes fall through the mount the same way.
    const sibling = await fetch(`${base}/d/nope/api/versions`);
    const learned = await fetch(`${base}/d/nope/api/theme/learned`);
    assert.equal(sibling.status, 404, "sibling baseline: unknown doc is a 404");
    assert.equal(learned.status, sibling.status, "same unknown-doc handling as siblings");
  } finally { await cleanup(); }
});
