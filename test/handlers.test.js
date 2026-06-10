// handlers.test.js — materialization layer (ADR-0019), driven directly with a spy emit.
// No bus, no server — just (dir, payload, ctx) → workspace mutations + emitted facts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import {
  materializeFeedback, materializeEdit, materializeDraft,
  materializeSourceAttached, materializeSourceUpdated, appendConversation,
} from "../src/service/handlers.js";

function ws(html = "<h1>Q2 Results</h1><p>body</p>") {
  const dir = mkdtempSync(join(tmpdir(), "wi-handlers-"));
  initWorkspace(dir, html);
  return dir;
}
function spyCtx(documentId = "t1") {
  const events = [];
  return { documentId, events, emit: (type, payload) => events.push({ type, payload }) };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test("materializeFeedback applies a deterministic edit and emits version.created + feedback.processed", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    const out = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
    }, ctx);
    assert.equal(out.version, 1);
    assert.equal(loadManifest(dir).head, 1, "manifest advanced to v1");
    const html = readFileSync(join(dir, "_v1.html"), "utf-8");
    assert.match(html, /Q3 Results/, "deterministic edit applied");
    const types = ctx.events.map((e) => e.type);
    assert.deepEqual(types, ["wicked.version.created", "wicked.feedback.processed"]);
    const vc = ctx.events[0].payload;
    assert.equal(vc.version, 1); assert.equal(vc.parent, 0); assert.equal(vc.kind, "deterministic");
    const fp = ctx.events[1].payload;
    assert.equal(fp.awaiting_structural, 0);
    assert.deepEqual(fp.structural_items, []);
  } finally { cleanup(dir); }
});

test("materializeFeedback surfaces structural items inline (no request file)", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "make it punchier" }],
    }, ctx);
    const fp = ctx.events.find((e) => e.type === "wicked.feedback.processed").payload;
    assert.equal(fp.awaiting_structural, 1);
    assert.equal(fp.structural_items[0].selector, "slide-0-heading-1");
    assert.equal(fp.structural_items[0].instruction, "make it punchier");
    assert.match(fp.structural_items[0].fragment, /data-wid="slide-0-heading-1"/, "current fragment extracted");
    assert.ok(!existsSync(join(dir, "requests", "_v1.request.json")), "NO request file written (event-native)");
  } finally { cleanup(dir); }
});

test("materializeEdit lands the agent's structural result as a follow-on version", async () => {
  const dir = ws();
  const ctx = spyCtx();
  try {
    // First, a feedback that defers a structural item -> v1 partial.
    const fb = await materializeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }],
    }, ctx);
    const item = fb.structural_items[0];
    ctx.events.length = 0;
    // Agent returns an edited fragment that PRESERVES the data-wid (INV-2).
    const edited = item.fragment.replace(/Q2 Results/, "Q2 — Crushed It");
    const out = await materializeEdit(dir, { version: fb.version, results: [{ selector: item.selector, fragment: edited }] }, ctx);
    assert.equal(out.parent, 1);
    assert.equal(out.version, 2);
    assert.equal(loadManifest(dir).head, 2);
    const vc = ctx.events.find((e) => e.type === "wicked.version.created").payload;
    assert.equal(vc.kind, "structural");
    assert.match(readFileSync(join(dir, "_v2.html"), "utf-8"), /Crushed It/);
  } finally { cleanup(dir); }
});

test("materializeDraft lands a generated draft from inline html", async () => {
  const dir = ws("<section><h1>Building…</h1></section>");
  const ctx = spyCtx();
  try {
    const out = await materializeDraft(dir, { html: "<section><h1>Investor Update</h1><p>Real numbers.</p></section>" }, ctx);
    assert.equal(out.version, 1);
    const html = readFileSync(join(dir, "_v1.html"), "utf-8");
    assert.match(html, /Investor Update/);
    assert.match(html, /data-wid=/, "fresh anchors assigned");
    assert.equal(ctx.events.find((e) => e.type === "wicked.version.created").payload.kind, "generated");
  } finally { cleanup(dir); }
});

test("materializeDraft reads html_path when html is absent (big-payload path, D5)", async () => {
  const dir = ws("<section><h1>Building…</h1></section>");
  const ctx = spyCtx();
  try {
    const htmlPath = join(dir, "draft.html");
    writeFileSync(htmlPath, "<section><h1>From Disk</h1></section>");
    const out = await materializeDraft(dir, { html_path: htmlPath }, ctx);
    assert.equal(out.version, 1);
    assert.match(readFileSync(join(dir, "_v1.html"), "utf-8"), /From Disk/);
  } finally { cleanup(dir); }
});

test("source attach + update round-trips through sources.json", () => {
  const dir = ws();
  try {
    materializeSourceAttached(dir, { added: [{ path: "/tmp/a.txt", note: "use" }, { path: "/tmp/a.txt" }] });
    let saved = JSON.parse(readFileSync(join(dir, "requests", "sources.json"), "utf-8"));
    assert.equal(saved.sources.length, 1, "duplicate path collapsed");
    assert.equal(saved.sources[0].status, "pending");
    materializeSourceUpdated(dir, { path: "/tmp/a.txt", status: "indexed" });
    saved = JSON.parse(readFileSync(join(dir, "requests", "sources.json"), "utf-8"));
    assert.equal(saved.sources[0].status, "indexed");
    assert.ok(saved.sources[0].indexed_at);
  } finally { cleanup(dir); }
});

test("appendConversation persists transcript lines", () => {
  const dir = ws();
  try {
    appendConversation(dir, { role: "user", text: "make it premium" });
    appendConversation(dir, { role: "agent", text: "on it", state: "processing" });
    const lines = readFileSync(join(dir, "conversation.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].role, "user");
    assert.equal(lines[1].state, "processing");
  } finally { cleanup(dir); }
});
