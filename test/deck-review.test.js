// deck-review.test.js — a deck's review store (DES-PRESENTATION-EDITOR-001 I-D2, the approvals half).
//
// A slide approval is given on a version and carries forward only while that slide's content hash is
// unchanged (D5): a move keeps it, an edit to the slide's words or notes shows it as changed since.
// The audience is recorded (D8); one audience proposal is open at a time (D3). Review records only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cheerio from "cheerio";
import { deckOutline } from "../src/core/deck.js";
import { audienceProblem, decisionProblem, reviewOf, slideHashes } from "../src/core/deck-review.js";
import { forkVersion, initWorkspace, loadManifest, readVersionHtml, rethemeHead } from "../src/service/workspace.js";
import { materializeDeckOp, materializeFeedback } from "../src/service/handlers.js";
import { closeProposal, openProposal, readStore, recordDecision, reviewFor, setAudience } from "../src/service/deck-review.js";
import { createServer } from "../src/service/server.js";

const DECK = [
  "<section><h1>Q3 review</h1><p>Where we are</p></section>",
  "<section><h2>Revenue</h2><ul><li>Up 18%</li></ul></section>",
  "<section><h2>Next</h2><p>Hire two AEs</p></section>",
].join("");

function deck(html = DECK, style = "ppt") {
  const dir = mkdtempSync(join(tmpdir(), "wi-review-"));
  initWorkspace(dir, html, { style, theme: false });
  return dir;
}
const head = (dir) => loadManifest(dir).head;
const idsOf = (html) => deckOutline(cheerio.load(html, null, false)).map((s) => s.id);
const quiet = { emit: () => {}, themeOpts: { theme: false } };
const deckOp = (dir, op) => materializeDeckOp(dir, { expect_head: head(dir), op }, quiet);
const at = (n) => () => `2026-10-13T00:00:0${n}Z`;

test("every top-level slide has a content hash; a nested section is part of its slide", () => {
  const h = slideHashes('<section data-slide-id="a"><h1>A</h1><section><p>in A</p></section></section><section data-slide-id="b"><h1>B</h1></section>');
  assert.deepEqual(h.map((s) => s.slide_id), ["a", "b"]);
  assert.match(h[0].hash, /^[0-9a-f]{64}$/);
  assert.notEqual(h[0].hash, h[1].hash);
});

test("reviewOf: the newest decision per slide, current only on the same hash; cleared shows none", () => {
  const slides = [{ slide_id: "a", hash: "h1" }, { slide_id: "b", hash: "h2" }, { slide_id: "c", hash: "h3" }];
  const r = reviewOf(slides, [
    { slide_id: "a", version: 1, hash: "h1", decision: "changes_requested", note: "tighter", at: "t1" },
    { slide_id: "a", version: 2, hash: "h1", decision: "approved", at: "t2" },
    { slide_id: "b", version: 1, hash: "old", decision: "approved", at: "t1" },
    { slide_id: "c", version: 1, hash: "h3", decision: "approved", at: "t1" },
    { slide_id: "c", version: 2, hash: "h3", decision: "cleared", at: "t2" },
    { slide_id: "gone", version: 1, hash: "x", decision: "approved", at: "t1" },
    null, { slide_id: "a", decision: "approved" },
  ], new Set([0, 1, 2]));
  assert.deepEqual(r.map((s) => s.slide_id), ["a", "b", "c"]);
  assert.deepEqual(r[0].decision, { decision: "approved", version: 2, note: null, at: "t2", current: true });
  assert.equal(r[1].decision.current, false, "approved on v1, changed since");
  assert.equal(r[2].decision, null);
});

test("shape checks: decisions and audiences", () => {
  assert.equal(decisionProblem({ version: 1, slide_id: "a", decision: "approved" }), null);
  assert.match(decisionProblem({ slide_id: "a", decision: "approved" }), /version/);
  assert.match(decisionProblem({ version: 1, slide_id: "a", decision: "ship-it" }), /decision/);
  assert.match(decisionProblem({ version: 1, slide_id: "a", decision: "approved", note: "x".repeat(2001) }), /note/);
  assert.equal(audienceProblem({ preset: "exec" }), null);
  assert.equal(audienceProblem({ preset: "custom", label: "Board of trustees" }), null);
  assert.match(audienceProblem({ preset: "custom" }), /label/);
  assert.match(audienceProblem({ preset: "everyone" }), /preset/);
});

test("an approval carries forward through a move, and not through an edit to the slide's notes or words", async () => {
  const dir = deck();
  try {
    const [a, b, c] = idsOf(readVersionHtml(dir, 0));
    assert.ok(recordDecision(dir, { version: 0, slide_id: a, decision: "approved" }, { now: at(1) }).decision);
    assert.ok(recordDecision(dir, { version: 0, slide_id: b, decision: "approved" }, { now: at(2) }).decision);
    assert.ok(recordDecision(dir, { version: 0, slide_id: c, decision: "changes_requested", note: "Name the AEs" }, { now: at(3) }).decision);
    // v1: a moves to the end (its markup is unchanged)
    assert.equal((await deckOp(dir, { type: "slide-move", slide: a, after: c })).version, 1);
    // v2: b gets speaker notes (its markup changes)
    assert.equal((await deckOp(dir, { type: "notes-set", slide: b, text: "Say the margin number" })).version, 2);
    const r = reviewFor(dir);
    assert.equal(r.version, 2);
    assert.deepEqual(r.slides.map((s) => s.slide_id), [b, c, a], "document order");
    const by = Object.fromEntries(r.slides.map((s) => [s.slide_id, s.decision]));
    assert.equal(by[a].current, true, "moved, unchanged: still approved");
    assert.equal(by[a].version, 0);
    assert.equal(by[b].current, false, "notes changed: approved on v0, changed since");
    assert.deepEqual([by[c].decision, by[c].note, by[c].current], ["changes_requested", "Name the AEs", true]);
    // v3: c's words change through the feedback pipeline
    const wid = cheerio.load(readVersionHtml(dir, 2), null, false)(`[data-slide-id="${c}"] p`).attr("data-wid");
    await materializeFeedback(dir, { author: "t", items: [{ selector: wid, type: "content-edit", value: "Hire three AEs", before: "Hire two AEs" }] }, quiet);
    assert.equal(head(dir), 3);
    const r3 = reviewFor(dir);
    assert.equal(r3.slides.find((s) => s.slide_id === c).decision.current, false);
    // the older version still reads as it was
    assert.equal(reviewFor(dir, 0).slides.find((s) => s.slide_id === b).decision.current, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a decision needs a deck, a version it has and a slide that version has", () => {
  const dir = deck();
  const page = deck("<section><h1>Not a deck</h1></section>", "doc");
  try {
    const [a] = idsOf(readVersionHtml(dir, 0));
    assert.equal(recordDecision(dir, { version: 9, slide_id: a, decision: "approved" }).status, 404);
    assert.equal(recordDecision(dir, { version: 0, slide_id: "snope", decision: "approved" }).status, 422);
    assert.equal(recordDecision(dir, { version: 0, slide_id: a, decision: "nope" }).status, 400);
    assert.equal(recordDecision(page, { version: 0, slide_id: "x", decision: "approved" }).status, 409);
    assert.equal(reviewFor(page).error, "not_a_deck");
    assert.deepEqual(readStore(dir).decisions, []);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(page, { recursive: true, force: true }); }
});

test("audience and proposal: one proposal at a time; kept records its audience, dropped does not", () => {
  const dir = deck();
  try {
    assert.equal(reviewFor(dir).audience, null);
    assert.deepEqual(setAudience(dir, { version: 0, preset: "eng" }, { now: at(1) }).audience, { preset: "eng", label: null, version: 0, at: "2026-10-13T00:00:01Z" });
    assert.equal(openProposal(dir, { base: 0, preset: "custom", label: "  Board  " }, { now: at(2) }).proposal.label, "Board");
    const again = openProposal(dir, { base: 0, preset: "exec" });
    assert.equal(again.status, 409);
    assert.equal(again.error, "proposal_open");
    assert.equal(reviewFor(dir).proposal.preset, "custom");
    assert.equal(closeProposal(dir, { outcome: "dropped" }).outcome, "dropped");
    assert.equal(reviewFor(dir).audience.preset, "eng", "a dropped proposal leaves the audience");
    assert.equal(closeProposal(dir, { outcome: "dropped" }).status, 409, "nothing open");
    openProposal(dir, { base: 0, preset: "exec" });
    assert.equal(closeProposal(dir, { outcome: "kept" }).status, 400, "kept names the version kept");
    assert.equal(closeProposal(dir, { outcome: "kept", version: 0 }).audience.preset, "exec");
    assert.equal(reviewFor(dir).proposal, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a store file that cannot be read is an empty review, never a crash", () => {
  const dir = deck();
  try {
    writeFileSync(join(dir, "deck-review.json"), "{ not json");
    assert.deepEqual(reviewFor(dir).slides.map((s) => s.decision), [null, null, null]);
    const [a] = idsOf(readVersionHtml(dir, 0));
    assert.ok(recordDecision(dir, { version: 0, slide_id: a, decision: "approved" }).decision);
    assert.equal(readStore(dir).decisions.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP: GET review, POST decisions, PUT audience, proposal open/close — each write announced", async () => {
  const dir = deck();
  const events = [];
  const svc = createServer({ dir, emit: (type, payload) => events.push({ type, payload }) });
  const port = await svc.start(0);
  const call = (method, path, body) => fetch(`http://localhost:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const [a] = idsOf(readVersionHtml(dir, 0));
    const r0 = await (await call("GET", "/api/deck/review")).json();
    assert.equal(r0.slides.length, 3);
    assert.equal((await call("GET", "/api/deck/review?version=x")).status, 400);
    assert.equal((await call("GET", "/api/deck/review?version=7")).status, 404);
    assert.equal((await call("POST", "/api/deck/decisions", { version: 0, slide_id: a, decision: "approved" })).status, 200);
    assert.equal((await call("POST", "/api/deck/decisions", { version: 0, slide_id: "snope", decision: "approved" })).status, 422);
    assert.equal((await call("PUT", "/api/deck/audience", { version: 0, preset: "customer" })).status, 200);
    assert.equal((await call("POST", "/api/deck/proposal", { base: 0, preset: "exec" })).status, 200);
    assert.equal((await call("POST", "/api/deck/proposal", { base: 0, preset: "eng" })).status, 409);
    assert.equal((await call("POST", "/api/deck/proposal/close", { outcome: "kept", version: 0 })).status, 200);
    const r1 = await (await call("GET", "/api/deck/review")).json();
    assert.equal(r1.slides[0].decision.decision, "approved");
    assert.equal(r1.audience.preset, "exec");
    assert.deepEqual(events.map((e) => [e.type, e.payload.state ?? e.payload.decision]), [
      ["wicked.interactive.slide.decided", "approved"],
      ["wicked.interactive.audience.changed", "set"],
      ["wicked.interactive.audience.changed", "proposed"],
      ["wicked.interactive.audience.changed", "kept"],
    ]);
  } finally { await svc.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// ── codex r1 on I-D2 ──────────────────────────────────────────────────────────────────────────────

test("codex r1: a re-theme changes every slide's hash (a stale approval never reads current); a move does not", async () => {
  const dir = deck();
  try {
    const [a] = idsOf(readVersionHtml(dir, 0));
    recordDecision(dir, { version: 0, slide_id: a, decision: "approved" });
    const out = rethemeHead(dir, { colors: { primary: "#112233" } });
    assert.equal(out.unchanged, false);
    assert.equal(reviewFor(dir).slides.find((s) => s.slide_id === a).decision.current, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r1: damaged rows in a well-formed store are skipped, never a failed read", () => {
  const dir = deck();
  try {
    const [a] = idsOf(readVersionHtml(dir, 0));
    writeFileSync(join(dir, "deck-review.json"), JSON.stringify({ decisions: [null, 7, { slide_id: a }], audience: "eng", proposal: { base: "x" } }));
    const r = reviewFor(dir);
    assert.deepEqual(r.slides.map((s) => s.decision), [null, null, null]);
    assert.equal(r.audience, null);
    assert.equal(r.proposal, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r1: a decision never carries back to an earlier version, nor across to a sibling fork", async () => {
  const dir = deck();
  try {
    const [a, b] = idsOf(readVersionHtml(dir, 0));
    assert.equal((await deckOp(dir, { type: "notes-set", slide: b, text: "v1 notes" })).version, 1);
    recordDecision(dir, { version: 1, slide_id: a, decision: "approved" });
    assert.equal(reviewFor(dir, 1).slides.find((s) => s.slide_id === a).decision.current, true);
    assert.equal(reviewFor(dir, 0).slides.find((s) => s.slide_id === a).decision, null, "given on v1: not on v0");
    // v2 forks v0 (an undo of v1): v1's approval is on a sibling branch, so it does not apply
    assert.equal(forkVersion(dir, 0).version, 2);
    assert.equal(reviewFor(dir, 2).slides.find((s) => s.slide_id === a).decision, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r2: a stylesheet's media, sheet order or a wrapper's attributes change every hash; insert and delete do not", async () => {
  const base = '<style media="print">h1{color:red}</style><link rel="stylesheet" href="a.css"><main class="deck"><section data-slide-id="a"><h1>A</h1></section><section data-slide-id="b"><h1>B</h1></section></main>';
  const h = (html) => slideHashes(html).find((s) => s.slide_id === "a").hash;
  assert.notEqual(h(base), h(base.replace('media="print"', 'media="all"')));
  assert.notEqual(h(base), h('<link rel="stylesheet" href="a.css"><style media="print">h1{color:red}</style>' + base.slice(base.indexOf("<main"))));
  assert.notEqual(h(base), h(base.replace('class="deck"', 'class="deck dark"')));
  assert.equal(h(base), h(base.replace('<section data-slide-id="b"><h1>B</h1></section>', "")), "a slide deleted");
  assert.equal(h(base), h(base.replace("</main>", '<section data-slide-id="c"><h1>C</h1></section></main>')), "a slide added");
  const dir = deck();
  try {
    const [a, b, c] = idsOf(readVersionHtml(dir, 0));
    recordDecision(dir, { version: 0, slide_id: a, decision: "approved" });
    await deckOp(dir, { type: "slide-insert", slide: b, after: c });
    await deckOp(dir, { type: "slide-duplicate", slide: b });
    assert.equal(reviewFor(dir).slides.find((s) => s.slide_id === a).decision.current, true, "insert + duplicate elsewhere keep a's approval");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r3: <body> attributes count; a delete or move across a separated run keeps other slides' hashes", () => {
  const h = (html, id = "a") => slideHashes(html).find((s) => s.slide_id === id).hash;
  const doc = (body, main) => `<!doctype html><html><head><style>.dark h1{color:#fff}</style></head><body${body}><main>${main}</main></body></html>`;
  const A = '<section data-slide-id="a"><h1>A</h1></section>';
  const B = '<section data-slide-id="b"><h1>B</h1></section>';
  assert.notEqual(h(doc(' class="light"', A + B)), h(doc(' class="dark"', A + B)));
  const sep = doc("", `${A}<style>p{margin:0}</style>${B}`);
  assert.equal(h(sep), h(doc("", `${A}<style>p{margin:0}</style>`)), "B deleted");
  assert.equal(h(sep), h(doc("", `${B}${A}<style>p{margin:0}</style>`)), "B moved beside A");
  assert.equal(h(sep, "b"), h(doc("", `${B}${A}<style>p{margin:0}</style>`), "b"), "B moved, same wrapper");
  assert.notEqual(h(sep, "b"), h(doc("", `${A}<style>p{margin:0}</style>`).replace("</main>", `</main><div class="aside">${B}</div>`), "b"), "B moved under another wrapper");
});

test("codex r4: a formatted deck — deleting a slide's line keeps the other slides' hashes", async () => {
  const h = (html) => slideHashes(html).find((s) => s.slide_id === "a").hash;
  const A = '<section data-slide-id="a"><h1>A</h1></section>';
  const B = '<section data-slide-id="b"><h1>B</h1></section>';
  assert.equal(h(`<main>\n  ${A}\n  ${B}\n</main>`), h(`<main>\n  ${A}\n</main>`));
  const dir = deck(["<main>", "<section><h1>One</h1></section>", "<section><h1>Two</h1></section>", "<section><h1>Three</h1></section>", "</main>"].join("\n"));
  try {
    const [a, b] = idsOf(readVersionHtml(dir, 0));
    recordDecision(dir, { version: 0, slide_id: a, decision: "approved" });
    const wid = cheerio.load(readVersionHtml(dir, 0), null, false)(`[data-slide-id="${b}"]`).attr("data-wid");
    await materializeFeedback(dir, { author: "t", items: [{ selector: wid, type: "remove" }] }, quiet);
    assert.equal(head(dir), 1);
    assert.equal(reviewFor(dir).slides.length, 2);
    assert.equal(reviewFor(dir).slides.find((s) => s.slide_id === a).decision.current, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("codex r5: whitespace inside a stylesheet still counts", () => {
  const h = (css) => slideHashes(`<style>section::before{white-space:pre;content:"${css}"}</style><main>\n<section data-slide-id="a"><h1>A</h1></section>\n</main>`).find((s) => s.slide_id === "a").hash;
  assert.notEqual(h("A  B"), h("A B"));
});

test("codex r6: deleting the LAST formatted slide keeps the others' hashes", () => {
  const h = (html) => slideHashes(html).find((s) => s.slide_id === "a").hash;
  const A = '<section data-slide-id="a"><h1>A</h1></section>';
  const B = '<section data-slide-id="b"><h1>B</h1></section>';
  assert.equal(h(`<main>\n${A}\n${B}\n</main>`), h(`<main>\n${A}\n\n</main>`));
  assert.equal(h(`<main>\n${A}\n${B}\n</main>`), h(`<main>\n${B}\n${A}\n</main>`), "and a move");
  assert.notEqual(h(`<main>${A}</main><p>x  y</p>`), h(`<main>${A}</main><p>x y</p>`), "text keeps its own spaces");
});

test("codex r7: no-break spaces outside the slides still count", () => {
  const h = (gap) => slideHashes(`<header><b>A</b>${gap}<b>B</b></header><main><section data-slide-id="a"><h1>A</h1></section></main>`).find((s) => s.slide_id === "a").hash;
  assert.notEqual(h("&nbsp;&nbsp;"), h("&nbsp;"));
  assert.notEqual(h("\u00a0"), h(" "));
});

test("codex r8: a stylesheet inside another slide counts for every slide", () => {
  const h = (c) => slideHashes(`<main><section data-slide-id="a"><h1>A</h1></section><section data-slide-id="b"><style>h1{color:${c}}</style><h1>B</h1></section></main>`).find((s) => s.slide_id === "a").hash;
  assert.notEqual(h("red"), h("blue"));
});

test("codex r9: relocating a stylesheet across slide boundaries changes every hash", () => {
  const A = '<section data-slide-id="a"><h1>A</h1></section>';
  const red = "<style>h1{color:red}</style>";
  const blue = "<style>h1{color:blue}</style>";
  const h = (html) => slideHashes(html).find((s) => s.slide_id === "a").hash;
  assert.notEqual(
    h(`<main>${A}<section data-slide-id="b">${red}<h1>B</h1></section>${blue}<section data-slide-id="c"><h1>C</h1></section></main>`),
    h(`<main>${A}<section data-slide-id="b"><h1>B</h1></section>${blue}<section data-slide-id="c">${red}<h1>C</h1></section></main>`),
  );
});
