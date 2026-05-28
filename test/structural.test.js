import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, processFeedbackFile, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { splitItems, extractFragment, applyStructuralResponse, REQUESTS_DIR } from "../src/service/structural.js";

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

test("processFeedbackFile applies deterministic now and delegates structural", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [
        { selector: "slide-0-paragraph-1", type: "content-edit", before: "body text", value: "NEW BODY" },
        { selector: "slide-0-heading-1", type: "structural-change", instruction: "make the title punchy" },
      ],
    });
    const res = await processFeedbackFile(dir, file, {});
    // deterministic applied to the partial v1:
    assert.equal(res.version, 1);
    assert.deepEqual(res.applied, ["slide-0-paragraph-1"]);
    assert.match(readVersionHtml(dir, 1), />NEW BODY</);
    assert.match(readVersionHtml(dir, 1), />Old Title</, "structural NOT applied to the partial");
    // structural delegated:
    assert.equal(res.awaiting_structural, 1);
    const reqPath = join(dir, REQUESTS_DIR, "_v1.request.json");
    assert.ok(existsSync(reqPath));
    const req = JSON.parse(readFileSync(reqPath, "utf-8"));
    assert.equal(req.items[0].selector, "slide-0-heading-1");
    assert.match(req.items[0].fragment, /data-wid="slide-0-heading-1"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyStructuralResponse finalizes a follow-on version preserving the chain", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchy" }],
    });
    await processFeedbackFile(dir, file, {});       // partial v1 (no deterministic changes)
    // Simulate the agent fulfilling the request, preserving data-wid:
    writeFileSync(join(dir, REQUESTS_DIR, "_v1.response.json"), JSON.stringify({
      version: 1,
      results: [{ selector: "slide-0-heading-1", fragment: '<h1 data-wid="slide-0-heading-1">Punchy New Title</h1>' }],
    }));
    const res = await applyStructuralResponse(dir, "_v1.response.json", {});
    assert.equal(res.version, 2);
    assert.equal(res.parent, 1);
    assert.deepEqual(res.applied, ["slide-0-heading-1"]);
    assert.match(readVersionHtml(dir, 2), />Punchy New Title</);
    assert.equal(loadManifest(dir).head, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyStructuralResponse handles a remove directive (real deletion)", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-paragraph-1", type: "structural-change", instruction: "remove it" }],
    });
    await processFeedbackFile(dir, file, {});
    writeFileSync(join(dir, REQUESTS_DIR, "_v1.response.json"), JSON.stringify({
      version: 1, results: [{ selector: "slide-0-paragraph-1", remove: true }],
    }));
    const res = await applyStructuralResponse(dir, "_v1.response.json", {});
    assert.deepEqual(res.applied, ["slide-0-paragraph-1"]);
    assert.doesNotMatch(readVersionHtml(dir, res.version), /slide-0-paragraph-1/, "element deleted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("INV-2: an agent response that drops the data-wid is rejected", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "rewrite" }],
    });
    await processFeedbackFile(dir, file, {});
    writeFileSync(join(dir, REQUESTS_DIR, "_v1.response.json"), JSON.stringify({
      version: 1,
      results: [{ selector: "slide-0-heading-1", fragment: "<h1>no wid here</h1>" }], // drops the anchor
    }));
    const res = await applyStructuralResponse(dir, "_v1.response.json", {});
    assert.deepEqual(res.applied, []);
    assert.ok(res.rejected.some((r) => /inv2/.test(r.reason)));
    assert.match(readVersionHtml(dir, res.version), /data-wid="slide-0-heading-1"/, "anchor preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
