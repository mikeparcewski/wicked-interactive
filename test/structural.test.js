import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, applyFeedbackItems, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { splitItems, extractFragment, applyStructuralResults, resolveEditBase } from "../src/service/structural.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wi-struct-"));
  initWorkspace(dir, "<h1>Old Title</h1><p>body text</p>");
  return dir;
}

test("splitItems partitions structural from deterministic", () => {
  const { deterministic, structural } = splitItems([
    { selector: "a", type: "content-edit", value: "x" },
    { selector: "b", type: "structural-change", instruction: "rework" },
    { selector: "c", type: "style-edit", style: { color: "#c00" } },
  ]);
  assert.deepEqual(deterministic.map((i) => i.selector), ["a", "c"]);
  assert.deepEqual(structural.map((i) => i.selector), ["b"]);
});

test("extractFragment returns the element's outerHTML", () => {
  const html = '<h1 data-wid="slide-0-heading-1">Hi</h1><p data-wid="p1">x</p>';
  assert.match(extractFragment(html, "slide-0-heading-1"), /^<h1 data-wid="slide-0-heading-1">Hi<\/h1>$/);
  assert.equal(extractFragment(html, "nope"), null);
});

// Helper: run a feedback batch through the event-native core, returning the partial result.
async function applyBatch(dir, items) {
  const { version, parent } = writeFeedback(dir, { items });
  return applyFeedbackItems(dir, { version, parent, items }, {});
}

test("applyFeedbackItems applies deterministic now and surfaces structural items inline", async () => {
  const dir = fresh();
  try {
    const res = await applyBatch(dir, [
      { selector: "slide-0-paragraph-1", type: "content-edit", before: "body text", value: "NEW BODY" },
      { selector: "slide-0-heading-1", type: "structural-change", instruction: "make the title punchy" },
    ]);
    // deterministic applied to the partial v1:
    assert.equal(res.version, 1);
    assert.deepEqual(res.applied, ["slide-0-paragraph-1"]);
    assert.match(readVersionHtml(dir, 1), />NEW BODY</);
    assert.match(readVersionHtml(dir, 1), />Old Title</, "structural NOT applied to the partial");
    // structural surfaced inline (no request file) with the current fragment:
    assert.equal(res.structural_items.length, 1);
    assert.equal(res.structural_items[0].selector, "slide-0-heading-1");
    assert.match(res.structural_items[0].fragment, /data-wid="slide-0-heading-1"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyStructuralResults finalizes a follow-on version preserving the chain — a structural-only batch lands NO phantom partial (F-RECON-005)", async () => {
  const dir = fresh();
  try {
    const partial = await applyBatch(dir, [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchy" }]);
    // Nothing deterministic to apply → the content is unchanged → no version is minted. The
    // batch keeps its reserved number (the handoff id) and says what happened.
    assert.equal(partial.version, 1);
    assert.equal(partial.landed, false);
    assert.equal(partial.unchanged, true);
    assert.equal(partial.base_version, 0);
    assert.equal(partial.feedback_file, "_v1.md");
    assert.equal(loadManifest(dir).head, 0, "head did not move — v1 ≡ v0 would have been a phantom");
    assert.ok(!existsSync(join(dir, "_v1.html")), "no _v1.html for an unchanged batch");
    assert.ok(existsSync(join(dir, "_v1.md")), "the feedback itself is kept under its number");
    assert.match(partial.structural_items[0].fragment, /Old Title/, "fragment extracted from the base");
    // The agent fulfils against the handoff id, preserving data-wid:
    const res = await applyStructuralResults(dir, {
      version: partial.version,
      results: [{ selector: "slide-0-heading-1", fragment: '<h1 data-wid="slide-0-heading-1">Punchy New Title</h1>' }],
    }, {});
    // The EDIT is the version that gets the number, chained to the real base.
    assert.equal(res.version, 1);
    assert.equal(res.parent, 0);
    assert.deepEqual(res.applied, ["slide-0-heading-1"]);
    assert.match(readVersionHtml(dir, 1), />Punchy New Title</);
    const m = loadManifest(dir);
    assert.equal(m.head, 1);
    assert.equal(m.versions.find((v) => v.version === 1).feedback_file, "_v1.md", "the landed edit records the feedback that asked for it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mixed batch still lands its deterministic partial, and the edit chains onto THAT version (unchanged wire semantics)", async () => {
  const dir = fresh();
  try {
    const partial = await applyBatch(dir, [
      { selector: "slide-0-paragraph-1", type: "content-edit", before: "body text", value: "NEW BODY" },
      { selector: "slide-0-heading-1", type: "structural-change", instruction: "punchy" },
    ]);
    assert.equal(partial.landed, true);
    assert.equal(partial.unchanged, false);
    assert.equal(loadManifest(dir).head, 1);
    const res = await applyStructuralResults(dir, {
      version: partial.version,
      results: [{ selector: "slide-0-heading-1", fragment: '<h1 data-wid="slide-0-heading-1">Punchy</h1>' }],
    }, {});
    assert.equal(res.version, 2);
    assert.equal(res.parent, 1, "a landed partial IS the base, exactly as before");
    assert.match(readVersionHtml(dir, 2), />NEW BODY</);
    assert.match(readVersionHtml(dir, 2), />Punchy</);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveEditBase: landed html wins; else the feedback file's base_html; else the number itself", async () => {
  const dir = fresh();
  try {
    assert.deepEqual(resolveEditBase(dir, 0), { parent: 0, feedbackFile: null });
    await applyBatch(dir, [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "x" }]);   // reserves _v1.md, lands nothing
    assert.deepEqual(resolveEditBase(dir, 1), { parent: 0, feedbackFile: "_v1.md" });
    assert.deepEqual(resolveEditBase(dir, 7), { parent: 7, feedbackFile: null }, "unknown → left to readVersionHtml's honest ENOENT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two structural-only batches on the same head keep DISTINCT handoff ids (crew dedupes on doc:version)", async () => {
  const dir = fresh();
  try {
    const a = await applyBatch(dir, [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "one" }]);
    const b = await applyBatch(dir, [{ selector: "slide-0-paragraph-1", type: "structural-change", instruction: "two" }]);
    assert.equal(a.version, 1); assert.equal(b.version, 2);
    assert.equal(loadManifest(dir).head, 0);
    // Each edit chains onto the base and lands under its own number; nothing collides.
    const ra = await applyStructuralResults(dir, { version: 1, results: [{ selector: "slide-0-heading-1", fragment: '<h1 data-wid="slide-0-heading-1">One</h1>' }] }, {});
    assert.equal(ra.parent, 0);
    const rb = await applyStructuralResults(dir, { version: 2, results: [{ selector: "slide-0-paragraph-1", fragment: '<p data-wid="slide-0-paragraph-1">Two</p>' }] }, {});
    assert.equal(rb.parent, 0, "the second handoff was given against v0 too (its base_html)");
    assert.notEqual(ra.version, rb.version);
    assert.equal(loadManifest(dir).versions.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyStructuralResults handles a remove directive (real deletion)", async () => {
  const dir = fresh();
  try {
    const partial = await applyBatch(dir, [{ selector: "slide-0-paragraph-1", type: "structural-change", instruction: "remove it" }]);
    const res = await applyStructuralResults(dir, { version: partial.version, results: [{ selector: "slide-0-paragraph-1", remove: true }] }, {});
    assert.deepEqual(res.applied, ["slide-0-paragraph-1"]);
    assert.doesNotMatch(readVersionHtml(dir, res.version), /slide-0-paragraph-1/, "element deleted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("INV-2: an agent result that drops the data-wid is rejected", async () => {
  const dir = fresh();
  try {
    const partial = await applyBatch(dir, [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "rewrite" }]);
    const res = await applyStructuralResults(dir, {
      version: partial.version,
      results: [{ selector: "slide-0-heading-1", fragment: "<h1>no wid here</h1>" }], // drops the anchor
    }, {});
    assert.deepEqual(res.applied, []);
    assert.ok(res.rejected.some((r) => /inv2/.test(r.reason)));
    assert.match(readVersionHtml(dir, res.version), /data-wid="slide-0-heading-1"/, "anchor preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
