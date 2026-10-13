// deck.test.js — slide identity and the deck ops (DES-PRESENTATION-EDITOR-001 I-D1).
//
// Each op lands exactly one version through the feedback pipeline; a stale head is refused (C5);
// INV-2 holds (every anchor of the base is still there, except what `remove` deletes); order is the
// document's, identity is `data-slide-id`; speaker notes ride in the slide and reach the PPTX notes
// page (read back with python-pptx where it is installed — `WI_PYTHON` may name the interpreter).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as cheerio from "cheerio";
import { instrument, collectWids } from "../src/core/instrument.js";
import { deckOutline, SLIDE_ID_ATTR } from "../src/core/deck.js";
import { parseFeedback, serializeFeedback } from "../src/core/feedback-schema.js";
import { initWorkspace, loadManifest, readVersionHtml, writeFeedback, applyFeedbackItems } from "../src/service/workspace.js";
import { materializeDeckOp, materializeFeedback } from "../src/service/handlers.js";
import { createServer } from "../src/service/server.js";
import { exportPptx, pptxReady } from "../src/service/pptx.js";
import { saveManifest } from "../src/service/fsstore.js";

const DECK = [
  "<section><h1>Q3 review</h1><p>Where we are</p></section>",
  "<section><h2>Revenue</h2><ul><li>Up 18%</li><li>Margin held</li></ul></section>",
  "<section><h2>Next</h2><p>Hire two AEs</p></section>",
].join("");

const titlesOf = (html) => {
  const $ = cheerio.load(html, null, false);
  return $("section").toArray().filter((el) => $(el).parents("section").length === 0).map((el) => $(el).find("h1,h2").first().text());
};
const idsOf = (html) => deckOutline(cheerio.load(html, null, false)).map((s) => s.id);
const ctx = () => { const events = []; return { events, emit: (type, payload) => events.push({ type, payload }) }; };

function deck(html = DECK) {
  const dir = mkdtempSync(join(tmpdir(), "wi-deck-"));
  initWorkspace(dir, html, { style: "ppt", theme: false });
  return dir;
}
const head = (dir) => loadManifest(dir).head;
const headHtml = (dir) => readVersionHtml(dir, head(dir));
async function op(dir, o, expect = head(dir)) {
  const c = ctx();
  const r = await materializeDeckOp(dir, { expect_head: expect, op: o }, { ...c, themeOpts: { theme: false } });
  return { ...r, events: c.events };
}

test("a deck's top-level slides get a stable data-slide-id; a document's sections do not", () => {
  const once = instrument(DECK, { slideIds: true });
  assert.equal(once.slideIds.length, 3);
  assert.equal(new Set(once.slideIds).size, 3, "unique");
  const twice = instrument(once.html, { slideIds: true });
  assert.deepEqual(twice.slideIds, once.slideIds, "assigned once, kept");
  assert.equal(instrument(DECK, { slideIds: true }).html, once.html, "the same HTML gets the same ids (no phantom versions)");
  assert.doesNotMatch(instrument(DECK).html, new RegExp(SLIDE_ID_ATTR), "a document is left alone");
  // A nested section is part of its slide, not a slide.
  const nested = instrument("<section><h1>A</h1><section><p>inner</p></section></section><section><h2>B</h2></section>", { slideIds: true });
  assert.equal(nested.slideIds.length, 2);
});

test("identical slides still get distinct ids", () => {
  const { slideIds } = instrument("<section><h2>Same</h2></section><section><h2>Same</h2></section>", { slideIds: true });
  assert.equal(new Set(slideIds).size, 2);
});

test("slide-move: one version, document order changes, every anchor and id kept (INV-2)", async () => {
  const dir = deck();
  try {
    const base = headHtml(dir);
    const [a, b, c] = idsOf(base);
    const r = await op(dir, { type: "slide-move", slide: a, after: c });
    assert.equal(r.version, 1);
    assert.equal(head(dir), 1);
    const now = headHtml(dir);
    assert.deepEqual(idsOf(now), [b, c, a]);
    assert.deepEqual(titlesOf(now), ["Revenue", "Next", "Q3 review"]);
    for (const w of collectWids(base)) assert.ok(collectWids(now).includes(w), `INV-2 kept ${w}`);
    assert.equal(r.events.filter((e) => e.type === "wicked.interactive.version.created").length, 1);
    // To first.
    await op(dir, { type: "slide-move", slide: a, after: null });
    assert.deepEqual(idsOf(headHtml(dir)), [a, b, c]);
    assert.equal(head(dir), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a move to where the slide already is lands no version (unchanged), and says so", async () => {
  const dir = deck();
  try {
    const [a] = idsOf(headHtml(dir));
    const r = await op(dir, { type: "slide-move", slide: a, after: null });
    assert.equal(r.unchanged, true);
    assert.equal(head(dir), 0);
    assert.equal(r.events.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("slide-duplicate: the copy follows the original with fresh anchors and a fresh id; notes are copied", async () => {
  const dir = deck();
  try {
    const [a, b] = idsOf(headHtml(dir));
    await op(dir, { type: "notes-set", slide: b, text: "Say the number slowly." });
    const before = headHtml(dir);
    const r = await op(dir, { type: "slide-duplicate", slide: b });
    assert.equal(r.version, 2);
    const now = headHtml(dir);
    const ids = idsOf(now);
    assert.equal(ids.length, 4);
    assert.equal(ids[0], a);
    assert.equal(ids[1], b);
    assert.ok(![a, b].includes(ids[2]), "the copy has its own id");
    assert.deepEqual(titlesOf(now), ["Q3 review", "Revenue", "Revenue", "Next"]);
    const wids = collectWids(now);
    assert.equal(new Set(wids).size, wids.length, "no anchor is shared");
    for (const w of collectWids(before)) assert.ok(wids.includes(w), `INV-2 kept ${w}`);
    const outline = deckOutline(cheerio.load(now, null, false));
    assert.equal(outline[2].notes, "Say the number slowly.");
    const $ = cheerio.load(now, null, false);
    assert.equal($(`aside.notes[data-notes-for="${ids[2]}"]`).length, 1, "the copy's notes point at the copy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("slide-insert: the layout slide's structure, text cleared, notes dropped, placed after the named slide", async () => {
  const dir = deck();
  try {
    const [a, b, c] = idsOf(headHtml(dir));
    await op(dir, { type: "notes-set", slide: b, text: "notes of b" });
    await op(dir, { type: "slide-insert", slide: b, after: c });
    const now = headHtml(dir);
    const ids = idsOf(now);
    assert.deepEqual(ids.slice(0, 3), [a, b, c]);
    assert.equal(ids.length, 4);
    const $ = cheerio.load(now, null, false);
    const added = $(`[${SLIDE_ID_ATTR}="${ids[3]}"]`);
    assert.equal(added.find("h2").length, 1, "the heading carries over");
    assert.equal(added.find("li").length, 2, "the list carries over");
    assert.equal(added.text().trim(), "", "no text is copied");
    assert.equal(added.find("aside.notes").length, 0, "no notes are copied");
    assert.equal(added.find("[data-wid]").length > 0, true, "the new slide is anchored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("notes-set: text in the slide, hidden, never anchored, never markup; empty removes it", async () => {
  const dir = deck();
  try {
    const [, b] = idsOf(headHtml(dir));
    await op(dir, { type: "notes-set", slide: b, text: "Line one\nLine two <b>not bold</b>" });
    let $ = cheerio.load(headHtml(dir), null, false);
    const n = $(`aside.notes[data-notes-for="${b}"]`);
    assert.equal(n.length, 1);
    assert.notEqual(n.attr("hidden"), undefined, "hidden from every render");
    assert.equal(n.attr("data-wid"), undefined, "notes are not a review anchor");
    assert.equal(n.find("b").length, 0, "text, not markup");
    assert.equal(n.text(), "Line one\nLine two <b>not bold</b>");
    // Replaced, not appended.
    await op(dir, { type: "notes-set", slide: b, text: "Only this" });
    $ = cheerio.load(headHtml(dir), null, false);
    assert.equal($("aside.notes").length, 1);
    assert.equal($("aside.notes").text(), "Only this");
    await op(dir, { type: "notes-set", slide: b, text: "  " });
    assert.equal(cheerio.load(headHtml(dir), null, false)("aside.notes").length, 0);
    assert.equal(head(dir), 3, "one version per op");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale head is refused with nothing written (C5); a document that is not a deck is refused", async () => {
  const dir = deck();
  try {
    const [a, , c] = idsOf(headHtml(dir));
    await op(dir, { type: "slide-move", slide: a, after: c });
    const files = readdirSync(dir).length;
    const r = await op(dir, { type: "slide-move", slide: c, after: null }, 0);
    assert.deepEqual({ headMoved: r.headMoved, head: r.head }, { headMoved: true, head: 1 });
    assert.equal(readdirSync(dir).length, files, "nothing written");
    assert.equal(head(dir), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const doc = mkdtempSync(join(tmpdir(), "wi-deck-doc-"));
  try {
    initWorkspace(doc, DECK, { style: "doc", theme: false });
    const r = await materializeDeckOp(doc, { expect_head: 0, op: { type: "slide-duplicate", slide: "sabc" } }, ctx());
    assert.equal(r.notDeck, true);
  } finally { rmSync(doc, { recursive: true, force: true }); }
});

test("an op naming a slide the version does not have is refused with its reason", async () => {
  const dir = deck();
  try {
    const [a] = idsOf(headHtml(dir));
    assert.equal((await op(dir, { type: "slide-duplicate", slide: "snope" })).refused, "slide-not-found");
    assert.equal((await op(dir, { type: "slide-move", slide: a, after: "snope" })).refused, "after-slide-not-found");
    assert.equal((await op(dir, { type: "slide-move", slide: a, after: a })).refused, "after-is-the-slide");
    assert.equal(head(dir), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("feedback files round-trip the deck ops, multi-line notes included", () => {
  const items = [
    { selector: "s1", type: "slide-move", after: "" },
    { selector: "s1", type: "slide-insert", after: "s2" },
    { selector: "s2", type: "slide-duplicate" },
    { selector: "s2", type: "notes-set", value: "Two\nlines: \"quoted\" - list" },
  ];
  const md = serializeFeedback({ frontmatter: { version: 1, base_html: "_v0.html" }, items });
  const back = parseFeedback(md).items;
  assert.equal(back[0].after, "");
  assert.equal(back[1].after, "s2");
  assert.equal(back[2].type, "slide-duplicate");
  assert.equal(back[3].value, "Two\nlines: \"quoted\" - list");
  assert.throws(() => parseFeedback("---\nversion: 1\n---\n\n## item: s1\n- type: slide-move\n"), /missing 'after'/);
});

test("a legacy deck with no slide ids: a batch that changes nothing lands no version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-deck-legacy-"));
  try {
    // A deck made before I-D1: anchored, but no data-slide-id.
    initWorkspace(dir, DECK, { theme: false });
    const m = loadManifest(dir);
    saveManifest(dir, { ...m, style: "ppt" });
    const html0 = readVersionHtml(dir, 0);
    assert.doesNotMatch(html0, /data-slide-id/);
    const wid = collectWids(html0).find((w) => w.startsWith("slide-0-heading"));
    const items = [{ selector: wid, type: "content-edit", value: "Q3 review", before: "Q3 review" }];
    const { version, parent } = writeFeedback(dir, { items });
    const r = await applyFeedbackItems(dir, { version, parent, items }, { theme: false });
    assert.equal(r.landed, false, "no phantom version for the ids alone");
    assert.equal(loadManifest(dir).head, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bus feedback batch with a stale expect_head is refused with nothing written", async () => {
  const dir = deck();
  try {
    const [a, , c] = idsOf(headHtml(dir));
    await op(dir, { type: "slide-move", slide: a, after: c });
    const c2 = ctx();
    const r = await materializeFeedback(dir, { expect_head: 0, items: [{ selector: c, type: "slide-duplicate" }] }, { ...c2, themeOpts: { theme: false } });
    assert.equal(r.headMoved, true);
    assert.equal(head(dir), 1);
    assert.equal(c2.events[0].type, "wicked.interactive.status.posted");
    assert.equal(c2.events[0].payload.code, "head_moved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("POST /api/deck: expect_head required, op shape checked, 409 head_moved, one version per call", async () => {
  const dir = deck();
  const events = [];
  const svc = createServer({ dir, emit: (type, payload) => events.push({ type, payload }) });
  const port = await svc.start(0);
  const post = (body) => fetch(`http://localhost:${port}/api/deck`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const [a, , c] = idsOf(headHtml(dir));
    assert.equal((await post({ op: { type: "slide-move", slide: a, after: c } })).status, 400, "no expect_head");
    assert.equal((await post({ expect_head: 0, op: { type: "slide-shuffle", slide: a } })).status, 400);
    assert.equal((await post({ expect_head: 0, op: { type: "slide-move", slide: 'x"]', after: null } })).status, 400, "an id the selector cannot name");
    assert.equal((await post({ expect_head: 0, op: { type: "notes-set", slide: a } })).status, 400, "notes need text");
    const ok = await post({ expect_head: 0, op: { type: "slide-move", slide: a, after: c } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { version: 1, parent: 0 });
    const stale = await post({ expect_head: 0, op: { type: "slide-move", slide: c, after: null } });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "head_moved", head: 1 });
    const unknown = await post({ expect_head: 1, op: { type: "slide-duplicate", slide: "snope" } });
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json()).reason, "slide-not-found");
    assert.equal(events.filter((e) => e.type === "wicked.interactive.version.created").length, 1);
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

const PY = process.env.WI_PYTHON;
const READY = pptxReady(PY);
test("a reorder and notes round-trip through PPTX: slide order and the notes page (python-pptx read-back)",
  { skip: READY.ok ? false : "python-pptx not installed (set WI_PYTHON to an interpreter that has it)" }, async () => {
    const dir = deck();
    try {
      const [a, b, c] = idsOf(headHtml(dir));
      await op(dir, { type: "slide-move", slide: c, after: null });
      await op(dir, { type: "notes-set", slide: b, text: "Revenue notes\nsecond line" });
      const { path } = exportPptx(dir, head(dir), { ready: READY });
      const read = join(dir, "read.py");
      writeFileSync(read, [
        "import json, sys", "from pptx import Presentation", "p = Presentation(sys.argv[1])", "out = []",
        "for s in p.slides:",
        "    texts = [sh.text_frame.text for sh in s.shapes if sh.has_text_frame]",
        "    notes = s.notes_slide.notes_text_frame.text if s.has_notes_slide else ''",
        "    out.append({'title': texts[0] if texts else '', 'body': texts[1:], 'notes': notes})",
        "print(json.dumps(out))",
      ].join("\n"));
      const r = spawnSync(READY.python, [read, path], { encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const slides = JSON.parse(r.stdout);
      assert.deepEqual(slides.map((s) => s.title), ["Next", "Q3 review", "Revenue"]);
      assert.equal(slides[2].notes, "Revenue notes\nsecond line");
      assert.equal(slides[0].notes, "");
      assert.ok(!slides.some((s) => s.body.join(" ").includes("Revenue notes")), "notes never land on a slide");
      void a;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

// ── codex r1 on I-D1 ──────────────────────────────────────────────────────────────────────────────

test("codex r1: an existing id that is duplicated or cannot be named is minted again; valid ids are kept", () => {
  const { slideIds } = instrument('<section data-slide-id="same"><h2>A</h2></section><section data-slide-id="same"><h2>B</h2></section><section data-slide-id=\'x"]\'><h2>C</h2></section>', { slideIds: true });
  assert.equal(slideIds[0], "same");
  assert.equal(new Set(slideIds).size, 3);
  assert.ok(slideIds.every((id) => /^[A-Za-z0-9_-]+$/.test(id)));
});

test("codex r1: moving the only slide (or any slide) to where it already is touches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-deck-one-"));
  try {
    initWorkspace(dir, "<!doctype html><html><body><main><section><h1>Only</h1></section></main></body></html>", { style: "ppt", theme: false });
    const [a] = idsOf(headHtml(dir));
    const r = await op(dir, { type: "slide-move", slide: a, after: null });
    assert.equal(r.unchanged, true);
    assert.equal(head(dir), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const d2 = deck();
  try {
    const [a, b] = idsOf(headHtml(d2));
    assert.equal((await op(d2, { type: "slide-move", slide: b, after: a })).unchanged, true);
    assert.equal(head(d2), 0);
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

test("codex r1: a legacy deck (no ids on disk) answers to the ids a client reads from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-deck-legacy2-"));
  try {
    initWorkspace(dir, DECK, { theme: false });
    saveManifest(dir, { ...loadManifest(dir), style: "ppt" });
    assert.doesNotMatch(readVersionHtml(dir, 0), /data-slide-id/);
    const seen = instrument(readVersionHtml(dir, 0), { slideIds: true }).slideIds;
    const r = await op(dir, { type: "slide-move", slide: seen[0], after: seen[2] });
    assert.equal(r.version, 1);
    assert.deepEqual(idsOf(headHtml(dir)), [seen[1], seen[2], seen[0]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r1: notes that hold review anchors are refused as an item (422), never an INV-2 abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-deck-oldnotes-"));
  try {
    initWorkspace(dir, '<section><h1>A</h1><aside class="notes" data-notes-for="x" hidden><p data-wid="note-p">Old</p></aside></section>', { style: "ppt", theme: false });
    const [a] = idsOf(headHtml(dir));
    const r = await op(dir, { type: "notes-set", slide: a, text: "New" });
    assert.equal(r.refused, "notes-hold-anchors");
    assert.equal(head(dir), 0);
    assert.ok(collectWids(headHtml(dir)).includes("note-p"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r1: PPTX keeps a blank inserted slide, and a nested section's notes stay with their top-level slide",
  { skip: READY.ok ? false : "python-pptx not installed (set WI_PYTHON to an interpreter that has it)" }, async () => {
    const dir = deck("<section><h1>A</h1><p>a body</p><section><h2>Inner</h2></section><p>after inner</p></section><section><h1>B</h1></section>");
    try {
      const [a, b] = idsOf(headHtml(dir));
      await op(dir, { type: "notes-set", slide: a, text: "notes for A" });
      await op(dir, { type: "slide-insert", slide: b, after: b });
      const { path } = exportPptx(dir, head(dir), { ready: READY });
      const read = join(dir, "read.py");
      writeFileSync(read, [
        "import json, sys", "from pptx import Presentation", "p = Presentation(sys.argv[1])",
        "print(json.dumps([{'texts': [sh.text_frame.text for sh in s.shapes if sh.has_text_frame], 'notes': s.notes_slide.notes_text_frame.text if s.has_notes_slide else ''} for s in p.slides]))",
      ].join("\n"));
      const r = spawnSync(READY.python, [read, path], { encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const slides = JSON.parse(r.stdout);
      assert.equal(slides.length, 3, "A (with its nested section), B, and the blank inserted slide");
      assert.equal(slides[0].texts[0], "A");
      assert.ok(slides[0].texts.join(" ").includes("Inner") && slides[0].texts.join(" ").includes("after inner"));
      assert.equal(slides[0].notes, "notes for A");
      assert.equal(slides[1].texts[0], "B");
      assert.equal(slides[1].notes, "");
      assert.equal(slides[2].texts.join("").trim(), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

test("codex r2: a void element marked as a slide is not a slide (core and PPTX agree)", { skip: READY.ok ? false : "python-pptx not installed" }, async () => {
  const html = '<section><h1>A</h1><img data-slide class="slide" src="x.png"></section><section><h1>B</h1></section>';
  assert.equal(instrument(html, { slideIds: true }).slideIds.length, 2);
  const dir = deck(html);
  try {
    const { path } = exportPptx(dir, 0, { ready: READY });
    const r = spawnSync(READY.python, ["-c", "import sys; from pptx import Presentation; print(len(Presentation(sys.argv[1]).slides))", path], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r3: a notes aside is never a slide, whatever its class (core and PPTX agree)", { skip: READY.ok ? false : "python-pptx not installed" }, async () => {
  const html = '<aside class="slide notes" data-notes-for="x" hidden>n</aside><section><h1>B</h1></section>';
  assert.equal(instrument(html, { slideIds: true }).slideIds.length, 1);
  const dir = deck(html);
  try {
    const { path } = exportPptx(dir, 0, { ready: READY });
    const r = spawnSync(READY.python, ["-c", "import sys; from pptx import Presentation; print(len(Presentation(sys.argv[1]).slides))", path], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r4: a slide container inside a notes aside is notes, not a slide (core and PPTX agree)", { skip: READY.ok ? false : "python-pptx not installed" }, async () => {
  const html = '<aside class="slide notes" data-notes-for="x" hidden><section><h2>Speaker notes</h2></section></aside><section><h1>B</h1></section>';
  assert.equal(instrument(html, { slideIds: true }).slideIds.length, 1);
  const dir = deck(html);
  try {
    const { path } = exportPptx(dir, 0, { ready: READY });
    const r = spawnSync(READY.python, ["-c", "import sys; from pptx import Presentation; print(len(Presentation(sys.argv[1]).slides))", path], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
