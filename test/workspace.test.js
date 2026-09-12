import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, writeFeedback, applyFeedbackItems, loadManifest, readVersionHtml, contentHash } from "../src/service/workspace.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wi-ws-"));
  initWorkspace(dir, "<h1>Q2 Results</h1><p>body text</p>");
  return dir;
}

test("initWorkspace writes instrumented _v0.html and seeds the manifest", () => {
  const dir = fresh();
  try {
    const m = loadManifest(dir);
    assert.equal(m.head, 0);
    assert.match(readVersionHtml(dir, 0), /data-wid="slide-0-heading-1"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeFeedback allocates next version, writes _v{n}.md, leaves manifest untouched", () => {
  const dir = fresh();
  try {
    const { version, file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
    });
    assert.equal(version, 1);
    assert.equal(file, "_v1.md");
    assert.ok(existsSync(join(dir, "_v1.md")));
    assert.match(readFileSync(join(dir, "_v1.md"), "utf-8"), /base_html: _v0\.html/);
    assert.equal(loadManifest(dir).head, 0, "manifest head not advanced until processed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeFeedback rejects invalid feedback (content-edit without value)", () => {
  const dir = fresh();
  try {
    assert.throws(() => writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit" }],
    }), /missing 'value'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyFeedbackItems regenerates, writes _v{n}.html, advances the manifest", async () => {
  const dir = fresh();
  try {
    const items = [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }];
    const { version, parent } = writeFeedback(dir, { items });
    const res = await applyFeedbackItems(dir, { version, parent, items }, {});
    assert.equal(res.version, 1);
    assert.deepEqual(res.applied, ["slide-0-heading-1"]);
    assert.deepEqual(res.structural_items, [], "no structural items in a pure deterministic batch");
    assert.ok(existsSync(join(dir, "_v1.html")));
    assert.match(readVersionHtml(dir, 1), />Q3 Results</);
    const m = loadManifest(dir);
    assert.equal(m.head, 1);
    assert.equal(m.versions.find((v) => v.version === 1).parent, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyFeedbackItems is idempotent on re-processing the same version", async () => {
  const dir = fresh();
  try {
    const items = [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3" }];
    const { version, parent } = writeFeedback(dir, { items });
    await applyFeedbackItems(dir, { version, parent, items }, {});
    const second = await applyFeedbackItems(dir, { version, parent, items }, {});
    assert.equal(second.idempotent, true);
    assert.equal(loadManifest(dir).head, 1, "no duplicate version recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale before-snapshot is reported, not applied (AC-10 through the pipeline) — and lands no phantom version (F-RECON-005)", async () => {
  const dir = fresh();
  try {
    const items = [{ selector: "slide-0-heading-1", type: "content-edit", before: "WRONG", value: "Q3" }];
    const { version, parent } = writeFeedback(dir, { items });
    const res = await applyFeedbackItems(dir, { version, parent, items }, {});
    assert.deepEqual(res.stale, ["slide-0-heading-1"]);
    assert.deepEqual(res.applied, []);
    // Nothing was applied → the document did not change → no version exists that changes nothing.
    assert.equal(res.landed, false);
    assert.equal(res.unchanged, true);
    assert.equal(res.html_file, "_v0.html", "the current html is still the base");
    assert.ok(!existsSync(join(dir, "_v1.html")));
    assert.equal(loadManifest(dir).head, 0);
    assert.match(readVersionHtml(dir, 0), />Q2 Results</);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no phantom versions: a version is minted only when the prepared bytes differ (F-RECON-005)", async () => {
  const dir = fresh();
  try {
    // structural-only → unchanged
    let r = await applyFeedbackItems(dir, { ...writeFeedback(dir, { items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }] }), items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }] }, {});
    assert.equal(r.landed, false); assert.equal(loadManifest(dir).head, 0);
    // a content-edit to the SAME value → unchanged
    const same = [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q2 Results" }];
    r = await applyFeedbackItems(dir, { ...writeFeedback(dir, { items: same }), items: same }, {});
    assert.equal(r.landed, false); assert.equal(loadManifest(dir).head, 0);
    // a real change → landed, numbered past the reserved feedback files
    const real = [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }];
    r = await applyFeedbackItems(dir, { ...writeFeedback(dir, { items: real }), items: real }, {});
    assert.equal(r.landed, true); assert.equal(r.unchanged, false);
    assert.equal(r.version, 3, "numbers reserved by the unchanged batches' feedback files are never reused");
    assert.equal(loadManifest(dir).head, 3);
    assert.match(readVersionHtml(dir, 3), />Q3 Results</);
    assert.equal(contentHash("a"), contentHash("a"));
    assert.notEqual(contentHash("a"), contentHash("b"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
