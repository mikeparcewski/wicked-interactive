import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, applyFeedbackItems, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { splitItems, extractFragment, applyStructuralResults } from "../src/service/structural.js";

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

test("applyStructuralResults finalizes a follow-on version preserving the chain", async () => {
  const dir = fresh();
  try {
    const partial = await applyBatch(dir, [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchy" }]);
    // The agent fulfils, preserving data-wid:
    const res = await applyStructuralResults(dir, {
      version: partial.version,
      results: [{ selector: "slide-0-heading-1", fragment: '<h1 data-wid="slide-0-heading-1">Punchy New Title</h1>' }],
    }, {});
    assert.equal(res.version, 2);
    assert.equal(res.parent, 1);
    assert.deepEqual(res.applied, ["slide-0-heading-1"]);
    assert.match(readVersionHtml(dir, 2), />Punchy New Title</);
    assert.equal(loadManifest(dir).head, 2);
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
