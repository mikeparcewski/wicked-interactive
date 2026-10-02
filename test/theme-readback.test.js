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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from "node:fs";
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

// ── EP-I2: the write side — PUT/DELETE /d/:doc/api/theme/learned, and the reader's grammar ──

const jsend = (method, url, body) => fetch(url, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const versionCreated = async (doc) => {
  const { busDb } = await import("../src/service/bus-client.js");
  return busDb().prepare("SELECT payload FROM events WHERE event_type='wicked.interactive.version.created' ORDER BY event_id")
    .all().map((r) => JSON.parse(r.payload)).filter((p) => p.document_id === doc);
};
const VALID = {
  name: "acme-learned",
  colors: { background: "#0B1020", primary: "#8FB4FF", text_primary: "#E6E9F5" },
  fonts: { heading: "Inter", body: "Inter, sans-serif" },
  card: { border_radius: "12px", shadow: "0 1px 3px rgba(0,0,0,0.2)" },
};

test("PUT {tokens, apply:true} writes the file and lands one re-themed version of head, kind theme (EP-I2)", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "put-doc");
    const res = await jsend("PUT", `${base}/d/put-doc/api/theme/learned`, { tokens: VALID, apply: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual({ version: body.version, parent: body.parent, kind: body.kind }, { version: 1, parent: 0, kind: "theme" });
    // The file is the one the apply seam and the readback read.
    const file = join(root, "put-doc", "theme", "learned.theme.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), VALID);
    assert.deepEqual((await (await fetch(`${base}/d/put-doc/api/theme/learned`)).json()).tokens, VALID);
    // The new head wears the learned tokens; v0 is untouched (write-once).
    const head = await (await fetch(`${base}/d/put-doc/doc`)).text();
    assert.match(head, /data-wi-theme="acme-learned"/);
    assert.match(head, /--wi-primary:#8FB4FF/);
    assert.doesNotMatch(await (await fetch(`${base}/d/put-doc/doc/0`)).text(), /acme-learned/);
    const vc = await versionCreated("put-doc");
    assert.equal(vc.length, 1, "exactly one version.created");
    assert.deepEqual({ version: vc[0].version, parent: vc[0].parent, kind: vc[0].kind }, { version: 1, parent: 0, kind: "theme" });
    // Re-PUT of the same tokens changes nothing → no version, said so.
    const again = await (await jsend("PUT", `${base}/d/put-doc/api/theme/learned`, { tokens: VALID, apply: true })).json();
    assert.equal(again.version, null);
    assert.equal(again.unchanged, true);
    assert.equal((await versionCreated("put-doc")).length, 1);
  } finally { await cleanup(); }
});

test("PUT without apply writes the file and lands no version", async () => {
  const { base, cleanup } = await boot();
  try {
    await createDoc(base, "noapply-doc");
    const res = await jsend("PUT", `${base}/d/noapply-doc/api/theme/learned`, { tokens: VALID });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, null);
    assert.equal((await (await fetch(`${base}/d/noapply-doc/api/versions`)).json()).head, 0);
    assert.equal((await fetch(`${base}/d/noapply-doc/api/theme/learned`)).status, 200);
  } finally { await cleanup(); }
});

test("PUT refuses a bad shape or a bad-grammar value: 400 with the field, nothing written", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "badput-doc");
    for (const tokens of [
      undefined, "red", [],
      { ...VALID, colors: { primary: "red;}body{background:url(https://x/?a)" } },
      { ...VALID, fonts: { body: "Inter;}" } },
    ]) {
      const res = await jsend("PUT", `${base}/d/badput-doc/api/theme/learned`, { tokens, apply: true });
      assert.equal(res.status, 400, JSON.stringify(tokens));
      assert.match((await res.json()).error, /theme/);
    }
    assert.ok(!existsSync(join(root, "badput-doc", "theme", "learned.theme.json")), "nothing written");
    assert.equal((await (await fetch(`${base}/d/badput-doc/api/versions`)).json()).head, 0, "no version landed");
  } finally { await cleanup(); }
});

test("DELETE removes the learned theme so later versions stop wearing it; a second DELETE is 404", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "del-doc");
    assert.equal((await jsend("PUT", `${base}/d/del-doc/api/theme/learned`, { tokens: VALID, apply: true })).status, 200);
    const res = await jsend("DELETE", `${base}/d/del-doc/api/theme/learned`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { document_id: "del-doc", deleted: true });
    assert.ok(!existsSync(join(root, "del-doc", "theme", "learned.theme.json")));
    assert.equal((await fetch(`${base}/d/del-doc/api/theme/learned`)).status, 404);
    // Undo = fork from the parent; the fork carries v0's look, and nothing re-applies the theme.
    const fork = await (await jsend("POST", `${base}/d/del-doc/api/fork`, { from: 0 })).json();
    assert.doesNotMatch(await (await fetch(`${base}/d/del-doc/doc/${fork.version}`)).text(), /acme-learned/);
    assert.equal((await jsend("DELETE", `${base}/d/del-doc/api/theme/learned`)).status, 404);
  } finally { await cleanup(); }
});

test("the reader ignores a learned file whose value breaks the grammar: readback 404, never applied", async () => {
  const { base, root, cleanup } = await boot();
  try {
    await createDoc(base, "inject-doc");
    const themeDir = join(root, "inject-doc", "theme");
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, "learned.theme.json"), JSON.stringify({ ...VALID, colors: { primary: "red;}body{background:url(https://x/?a)" } }));
    const res = await fetch(`${base}/d/inject-doc/api/theme/learned`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no learned theme" });
  } finally { await cleanup(); }
});
