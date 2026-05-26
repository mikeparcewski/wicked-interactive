import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initWorkspace, writeFeedback, processFeedbackFile, loadManifest, readVersionHtml,
} from "../src/service/workspace.js";

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

test("processFeedbackFile regenerates, writes _v{n}.html, advances the manifest, emits", async () => {
  const dir = fresh();
  try {
    const events = [];
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
    });
    const res = await processFeedbackFile(dir, file, { emit: (k, p) => events.push([k, p]) });
    assert.equal(res.version, 1);
    assert.deepEqual(res.applied, ["slide-0-heading-1"]);
    assert.ok(existsSync(join(dir, "_v1.html")));
    assert.match(readVersionHtml(dir, 1), />Q3 Results</);
    const m = loadManifest(dir);
    assert.equal(m.head, 1);
    assert.equal(m.versions.find((v) => v.version === 1).parent, 0);
    assert.equal(events[0][0], "HTML_UPDATED");
    assert.equal(events[0][1].version, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("processFeedbackFile is idempotent on re-processing the same version", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3" }],
    });
    await processFeedbackFile(dir, file, {});
    const second = await processFeedbackFile(dir, file, {});
    assert.equal(second.idempotent, true);
    assert.equal(loadManifest(dir).head, 1, "no duplicate version recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale before-snapshot is reported, not applied (AC-10 through the pipeline)", async () => {
  const dir = fresh();
  try {
    const { file } = writeFeedback(dir, {
      items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "WRONG", value: "Q3" }],
    });
    const res = await processFeedbackFile(dir, file, {});
    assert.deepEqual(res.stale, ["slide-0-heading-1"]);
    assert.deepEqual(res.applied, []);
    assert.match(readVersionHtml(dir, 1), />Q2 Results</);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
