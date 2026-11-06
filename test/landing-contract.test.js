// landing-contract.test.js — DES-CHAT-ARTIFACTS-001 §6.2, slice I1.
//
// A generated landing can't overwrite a hand edit, and every version says which run made it:
//   • draft.completed {expect_head} lands only on that head; otherwise it lands nothing and emits
//     exactly one draft.conflict {run_id, expect_head, actual_head};
//   • draft.completed, edit.completed and the theme PUT accept run_id and record it on the version;
//   • version.created carries run_id, kind and parent on every path (run_id null for hand versions);
//   • a caller without the new fields lands exactly as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import { materializeFeedback, materializeEdit, materializeDraft } from "../src/service/handlers.js";
import { createServer } from "../src/service/server.js";
import { getVersion, readRunId } from "../src/core/versions.js";

const VC = "wicked.interactive.version.created";
const CONFLICT = "wicked.interactive.draft.conflict";
const VC_SCHEMA = JSON.parse(readFileSync(new URL("../src/service/event-schemas/wicked.interactive.version.created.json", import.meta.url), "utf-8"));
const CONFLICT_SCHEMA = JSON.parse(readFileSync(new URL("../src/service/event-schemas/wicked.interactive.draft.conflict.json", import.meta.url), "utf-8"));

function ws(html = "<h1>Q2 Results</h1><p>body</p>") {
  const dir = mkdtempSync(join(tmpdir(), "wi-landing-"));
  initWorkspace(dir, html);
  return dir;
}
function spyCtx(documentId = "t1") {
  const events = [];
  return { documentId, events, emit: (type, payload) => events.push({ type, payload }) };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const ofType = (events, type) => events.filter((e) => e.type === type).map((e) => e.payload);
const DRAFT = "<section><h1>Investor Update</h1><p>Numbers.</p></section>";

/** Every field the version.created schema requires except the ones the service emit stamps. */
function assertVersionCreatedShape(p) {
  for (const key of VC_SCHEMA.required) {
    if (key === "document_id" || key === "ts") continue;   // stamped by the service emit / the bus
    assert.ok(Object.hasOwn(p, key), `version.created carries ${key}`);
  }
  assert.ok(VC_SCHEMA.properties.kind.enum.includes(p.kind), `kind ${p.kind} is in the schema enum`);
  assert.ok(Number.isInteger(p.parent), "parent is a version number");
  assert.ok(p.run_id === null || typeof p.run_id === "string", "run_id is a string or null");
}

/** A hand edit: one deterministic feedback item that lands a version (head moves). */
async function handEdit(dir, ctx, value = "Q3 Results") {
  return materializeFeedback(dir, { items: [{ selector: "slide-0-heading-1", type: "content-edit", value }] }, ctx);
}

// ── draft.completed + expect_head (compare-and-set) ──────────────────────────────────────────

test("a stale expect_head lands nothing and emits exactly one draft.conflict", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await handEdit(dir, ctx);                                   // the person edits v0 → v1 while the run works from v0
    const before = readFileSync(join(dir, "versions.json"), "utf-8");
    ctx.events.length = 0;
    const out = await materializeDraft(dir, { html: DRAFT, expect_head: 0, run_id: "run-stale" }, ctx);
    assert.deepEqual(out, { conflict: true, expect_head: 0, actual_head: 1 });
    assert.equal(readFileSync(join(dir, "versions.json"), "utf-8"), before, "the manifest is byte-identical");
    assert.ok(!existsSync(join(dir, "_v2.html")), "no version file was written");
    assert.match(readFileSync(join(dir, "_v1.html"), "utf-8"), /Q3 Results/, "the hand edit is still the head");
    assert.deepEqual(ctx.events.map((e) => e.type), [CONFLICT], "exactly one event: the conflict");
    assert.deepEqual(ctx.events[0].payload, { run_id: "run-stale", expect_head: 0, actual_head: 1 });
    for (const key of CONFLICT_SCHEMA.required) {
      if (key === "document_id" || key === "ts") continue;
      assert.ok(Object.hasOwn(ctx.events[0].payload, key), `draft.conflict carries ${key}`);
    }
  } finally { cleanup(dir); }
});

test("a stale expect_head without a run_id still conflicts, with run_id null", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await handEdit(dir, ctx);
    ctx.events.length = 0;
    const out = await materializeDraft(dir, { html: DRAFT, expect_head: 0 }, ctx);
    assert.equal(out.conflict, true);
    assert.deepEqual(ofType(ctx.events, CONFLICT), [{ run_id: null, expect_head: 0, actual_head: 1 }]);
    assert.equal(loadManifest(dir).head, 1);
  } finally { cleanup(dir); }
});

test("a matching expect_head lands as today, recording the run on the version", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await handEdit(dir, ctx);
    ctx.events.length = 0;
    const out = await materializeDraft(dir, { html: DRAFT, expect_head: 1, run_id: "run-ok" }, ctx);
    assert.deepEqual({ version: out.version, parent: out.parent }, { version: 2, parent: 1 });
    const m = loadManifest(dir);
    assert.equal(m.head, 2);
    const entry = getVersion(m, 2);
    assert.deepEqual({ parent: entry.parent, kind: entry.kind, run_id: entry.run_id }, { parent: 1, kind: "generated", run_id: "run-ok" });
    assert.match(readFileSync(join(dir, "_v2.html"), "utf-8"), /Investor Update/);
    assert.deepEqual(ofType(ctx.events, CONFLICT), []);
    const [vc] = ofType(ctx.events, VC);
    assert.deepEqual(vc, { version: 2, parent: 1, kind: "generated", run_id: "run-ok", html_file: "_v2.html" });
    assertVersionCreatedShape(vc);
  } finally { cleanup(dir); }
});

test("a redelivered draft whose run already landed on that head re-announces it, not a conflict", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const payload = { html: DRAFT, expect_head: 0, run_id: "run-once" };
    await materializeDraft(dir, payload, ctx);                  // lands v1 (parent 0)
    ctx.events.length = 0;
    const again = await materializeDraft(dir, payload, ctx);    // the bus delivers it again
    assert.deepEqual(again, { version: 1, parent: 0, replayed: true });
    assert.equal(loadManifest(dir).versions.length, 2, "no second version");
    assert.deepEqual(ofType(ctx.events, CONFLICT), [], "no false conflict");
    assert.deepEqual(ofType(ctx.events, VC), [{ version: 1, parent: 0, kind: "generated", run_id: "run-once", html_file: "_v1.html" }]);
    // A different run with the same stale base is a real conflict.
    ctx.events.length = 0;
    const other = await materializeDraft(dir, { html: DRAFT, expect_head: 0, run_id: "run-other" }, ctx);
    assert.equal(other.conflict, true);
    assert.equal(ofType(ctx.events, CONFLICT).length, 1);
  } finally { cleanup(dir); }
});

test("a draft without the new fields lands exactly as before (on the current head, run_id null)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await handEdit(dir, ctx);
    ctx.events.length = 0;
    const out = await materializeDraft(dir, { html: DRAFT }, ctx);
    assert.deepEqual({ version: out.version, parent: out.parent }, { version: 2, parent: 1 });
    assert.deepEqual(ctx.events.map((e) => e.type), [VC]);
    assert.deepEqual(ctx.events[0].payload, { version: 2, parent: 1, kind: "generated", run_id: null, html_file: "_v2.html" });
    // A null expect_head / run_id (a Rust Option on the wire) is "absent", not malformed.
    ctx.events.length = 0;
    const nulls = await materializeDraft(dir, { html: DRAFT, expect_head: null, run_id: null }, ctx);
    assert.deepEqual({ version: nulls.version, parent: nulls.parent }, { version: 3, parent: 2 });
    assert.equal(getVersion(loadManifest(dir), 3).run_id, null);
  } finally { cleanup(dir); }
});

test("a malformed expect_head or run_id lands nothing and says why (no conflict, no retry)", async () => {
  const bad = [
    { field: "expect_head", value: "0" }, { field: "expect_head", value: -1 }, { field: "expect_head", value: 1.5 },
    { field: "run_id", value: 42 }, { field: "run_id", value: "" }, { field: "run_id", value: "x".repeat(201) },
    { field: "run_id", value: "run\nforged" },
  ];
  for (const { field, value } of bad) {
    const dir = ws();
    const ctx = spyCtx();
    try {
      const out = await materializeDraft(dir, { html: DRAFT, [field]: value }, ctx);
      assert.ok(out.refused, `${field}=${JSON.stringify(value)} is refused`);
      assert.equal(loadManifest(dir).head, 0, "nothing landed");
      assert.ok(!existsSync(join(dir, "_v1.html")));
      assert.deepEqual(ctx.events.map((e) => e.type), ["wicked.interactive.status.posted"]);
      assert.equal(ctx.events[0].payload.code, "invalid_landing");
      assert.equal(ctx.events[0].payload.retryable, false);
    } finally { cleanup(dir); }
  }
});

test("a conflict or refusal that can't be published fails the command; the retry publishes exactly one", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await handEdit(dir, ctx);
    ctx.events.length = 0;
    // The bus refuses the publish (e.g. SQLITE_BUSY): the handler must not resolve as if it said so.
    const failing = { ...ctx, emit: (type, payload) => (type === CONFLICT || type === "wicked.interactive.status.posted"
      ? Promise.reject(new Error("SQLITE_BUSY")) : ctx.emit(type, payload)) };
    await assert.rejects(materializeDraft(dir, { html: DRAFT, expect_head: 0, run_id: "run-retry" }, failing), /SQLITE_BUSY/);
    await assert.rejects(materializeDraft(dir, { html: DRAFT, run_id: 9 }, failing), /SQLITE_BUSY/);
    assert.equal(loadManifest(dir).head, 1, "nothing landed");
    // The bus retries the command: the same decision, published once.
    const out = await materializeDraft(dir, { html: DRAFT, expect_head: 0, run_id: "run-retry" }, ctx);
    assert.equal(out.conflict, true);
    assert.deepEqual(ofType(ctx.events, CONFLICT), [{ run_id: "run-retry", expect_head: 0, actual_head: 1 }]);
  } finally { cleanup(dir); }
});

// ── run_id on every landing path ─────────────────────────────────────────────────────────────

test("the run_id schemas of draft.completed and edit.completed accept exactly what the handlers accept", () => {
  const schemas = ["draft.completed", "edit.completed"].map((n) => JSON.parse(readFileSync(
    new URL(`../src/service/event-schemas/wicked.interactive.${n}.json`, import.meta.url), "utf-8")).properties.run_id);
  const bySchema = (s, v) => v === null
    || (typeof v === "string" && [...v].length >= s.minLength && [...v].length <= s.maxLength && new RegExp(s.pattern, "u").test(v));
  const samples = [null, "run-1", "", "x".repeat(200), "x".repeat(201), "run\nforged", "tab\there", "del\u007f",
    "\u{1F600}".repeat(200), "\u{1F600}".repeat(201), 42];
  for (const s of schemas) {
    for (const v of samples) {
      assert.equal(bySchema(s, v), !readRunId(v).problem, `schema and readRunId agree on ${JSON.stringify(v)?.slice(0, 40)}`);
    }
  }
});

test("edit.completed records its run_id on the version and on version.created", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const fb = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }],
    }, ctx);
    const item = fb.structural_items[0];
    ctx.events.length = 0;
    const edited = item.fragment.replace(/Q2 Results/, "Q2 — Crushed It");
    const out = await materializeEdit(dir, { version: fb.version, results: [{ selector: item.selector, fragment: edited }], run_id: "run-edit" }, ctx);
    const entry = getVersion(loadManifest(dir), out.version);
    assert.deepEqual({ kind: entry.kind, run_id: entry.run_id, parent: entry.parent }, { kind: "structural", run_id: "run-edit", parent: 0 });
    const [vc] = ofType(ctx.events, VC);
    assert.deepEqual(vc, { version: out.version, parent: 0, kind: "structural", run_id: "run-edit", html_file: `_v${out.version}.html` });
    assertVersionCreatedShape(vc);
  } finally { cleanup(dir); }
});

test("edit.completed without a run_id lands as before (run_id null); a malformed one lands nothing", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const fb = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }],
    }, ctx);
    const item = fb.structural_items[0];
    const results = [{ selector: item.selector, fragment: item.fragment.replace(/Q2 Results/, "Q2 — Better") }];
    ctx.events.length = 0;
    const refused = await materializeEdit(dir, { version: fb.version, results, run_id: 7 }, ctx);
    assert.ok(refused.refused);
    assert.equal(loadManifest(dir).head, 0, "a malformed run_id lands nothing");
    assert.deepEqual(ofType(ctx.events, VC), []);
    ctx.events.length = 0;
    const out = await materializeEdit(dir, { version: fb.version, results }, ctx);
    assert.equal(getVersion(loadManifest(dir), out.version).run_id, null);
    assert.equal(ofType(ctx.events, VC)[0].run_id, null);
  } finally { cleanup(dir); }
});

test("a hand edit's version records run_id null and kind deterministic (made by hand)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const out = await handEdit(dir, ctx);
    const entry = getVersion(loadManifest(dir), out.version);
    assert.ok(Object.hasOwn(entry, "run_id"), "the key is present: made after I1");
    assert.deepEqual({ kind: entry.kind, run_id: entry.run_id }, { kind: "deterministic", run_id: null });
    const [vc] = ofType(ctx.events, VC);
    assert.equal(vc.run_id, null);
    assertVersionCreatedShape(vc);
  } finally { cleanup(dir); }
});

test("an entry from before I1 keeps no run_id key (unknown) when later versions land", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // A manifest written by an older engine: a v1 with no kind / run_id keys.
    const m = loadManifest(dir);
    m.versions.push({ version: 1, parent: 0, feedback_file: null, html_file: "_v1.html", created_at: new Date().toISOString() });
    m.head = 1;
    writeFileSync(join(dir, "_v1.html"), readFileSync(join(dir, "_v0.html"), "utf-8"));
    writeFileSync(join(dir, "versions.json"), JSON.stringify(m, null, 2));
    await materializeDraft(dir, { html: DRAFT, expect_head: 1, run_id: "run-new" }, ctx);
    const after = loadManifest(dir);
    assert.ok(!Object.hasOwn(getVersion(after, 1), "run_id"), "the legacy entry is untouched (write-once)");
    assert.equal(getVersion(after, 2).run_id, "run-new");
  } finally { cleanup(dir); }
});

// ── HTTP paths: the theme PUT and a hand fork, and the FIFO ──────────────────────────────────

const TOKENS = {
  name: "acme-learned",
  colors: { background: "#0B1020", primary: "#8FB4FF", text_primary: "#E6E9F5" },
  fonts: { heading: "Inter", body: "Inter, sans-serif" },
};

async function serve() {
  const dir = ws();
  const events = [];
  const svc = createServer({ dir, documentId: "doc", emit: (type, payload) => events.push({ type, payload }), themeCheck: async () => ({ changed: true }) });
  const port = await svc.start(0);
  const send = (method, path, body) => fetch(`http://localhost:${port}${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { dir, svc, events, send, done: async () => { await svc.stop(); cleanup(dir); } };
}

test("the theme PUT records its run_id on the theme version and on version.created", async () => {
  const { dir, events, send, done } = await serve();
  try {
    const res = await send("PUT", "/api/theme/learned", { tokens: TOKENS, apply: true, run_id: "run-theme" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "theme");
    const entry = getVersion(loadManifest(dir), body.version);
    assert.deepEqual({ kind: entry.kind, run_id: entry.run_id, parent: entry.parent }, { kind: "theme", run_id: "run-theme", parent: 0 });
    const [vc] = ofType(events, VC);
    assert.deepEqual(vc, { version: body.version, parent: 0, kind: "theme", run_id: "run-theme", html_file: `_v${body.version}.html` });
    assertVersionCreatedShape(vc);
  } finally { await done(); }
});

test("a person's theme PUT records run_id null; a malformed run_id is a 400 with nothing written", async () => {
  const { dir, events, send, done } = await serve();
  try {
    const bad = await send("PUT", "/api/theme/learned", { tokens: TOKENS, apply: true, run_id: { id: "x" } });
    assert.equal(bad.status, 400);
    assert.ok(!existsSync(join(dir, "theme", "learned.theme.json")), "the tokens were not written");
    assert.equal(loadManifest(dir).head, 0);
    const res = await send("PUT", "/api/theme/learned", { tokens: TOKENS, apply: true });
    const body = await res.json();
    assert.equal(getVersion(loadManifest(dir), body.version).run_id, null);
    assert.equal(ofType(events, VC)[0].run_id, null);
  } finally { await done(); }
});

test("a hand fork carries no run_id: run_id null on the version and on version.created", async () => {
  const { dir, events, send, done } = await serve();
  try {
    const res = await send("POST", "/api/fork", { from: 0 });
    assert.equal(res.status, 200);
    const { version } = await res.json();
    const entry = getVersion(loadManifest(dir), version);
    assert.deepEqual({ kind: entry.kind, run_id: entry.run_id, parent: entry.parent }, { kind: "fork", run_id: null, parent: 0 });
    const [vc] = ofType(events, VC);
    assert.deepEqual(vc, { version, parent: 0, kind: "fork", run_id: null, html_file: `_v${version}.html` });
    assertVersionCreatedShape(vc);
  } finally { await done(); }
});

test("the head check runs on the doc FIFO: a hand edit queued ahead of the draft is seen", async () => {
  const { dir, svc, events, done } = await serve();
  try {
    const cmd = (event_type, payload) => svc.runCommand({ event_type, payload: { document_id: "doc", ...payload } });
    // Both enqueued at once: the hand edit first, then a draft made against v0.
    const [, draft] = await Promise.all([
      cmd("wicked.interactive.feedback.submitted", { items: [{ selector: "slide-0-heading-1", type: "content-edit", value: "Hand" }] }),
      cmd("wicked.interactive.draft.completed", { html: DRAFT, expect_head: 0, run_id: "run-fifo" }),
    ]);
    assert.deepEqual(draft, { conflict: true, expect_head: 0, actual_head: 1 });
    assert.equal(loadManifest(dir).head, 1);
    assert.deepEqual(ofType(events, CONFLICT), [{ run_id: "run-fifo", expect_head: 0, actual_head: 1 }]);
    assert.deepEqual(ofType(events, VC).map((p) => p.kind), ["deterministic"], "only the hand edit landed");
  } finally { await done(); }
});
