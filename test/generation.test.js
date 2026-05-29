import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import {
  writeGenerationRequest, applyGeneratedDraft, generationPlaceholder,
  GEN_REQUEST, GEN_RESPONSE, REQUESTS_DIR,
} from "../src/service/generation.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "wi-gen-"));
  initWorkspace(dir, generationPlaceholder("my-deck", ["~/notes"]));
  return dir;
}

test("generationPlaceholder escapes and names the source", () => {
  const html = generationPlaceholder("q3-update", ["~/notes/<x>"]);
  assert.match(html, /Building q3 update/);
  assert.match(html, /&lt;x&gt;/);          // source path is HTML-escaped
  assert.doesNotMatch(html, /<x>/);          // no raw injection
});

test("generationPlaceholder lists multiple locations", () => {
  const html = generationPlaceholder("deck", ["~/a", "./b.pptx"]);
  assert.match(html, /2 locations/);
  assert.match(html, /<li><code>~\/a<\/code><\/li>/);
  assert.match(html, /<li><code>\.\/b\.pptx<\/code><\/li>/);
});

test("writeGenerationRequest writes the request file the agent watches", () => {
  const dir = fresh();
  try {
    const { requestFile } = writeGenerationRequest(dir, {
      sourcePaths: ["~/notes", " ", "./extra.md"], brief: "6 slides", documentId: "my-deck",
    });
    assert.equal(requestFile, GEN_REQUEST);
    const body = JSON.parse(readFileSync(join(dir, REQUESTS_DIR, GEN_REQUEST), "utf-8"));
    assert.equal(body.document_id, "my-deck");
    assert.deepEqual(body.source_paths, ["~/notes", "./extra.md"]); // trimmed + blanks dropped
    assert.equal(body.brief, "6 slides");
    assert.equal(body.base_html, "_v0.html");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyGeneratedDraft lands the draft as v1, instruments it, and emits", async () => {
  const dir = fresh();
  try {
    // Simulate the agent's reply: a full document with no anchors.
    const draft = "<section><h1>Q3 Results</h1><p>Revenue up 40%.</p></section>";
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, REQUESTS_DIR), { recursive: true });
    writeFileSync(join(dir, REQUESTS_DIR, GEN_RESPONSE), JSON.stringify({ html: draft }, null, 2));

    const emitted = [];
    const { version, parent } = await applyGeneratedDraft(dir, GEN_RESPONSE, {
      documentId: "my-deck", emit: (k, p) => emitted.push({ k, p }),
    });

    assert.equal(parent, 0, "parent is the placeholder v0");
    assert.equal(version, 1, "draft lands as v1");

    const html = readVersionHtml(dir, 1);
    assert.match(html, /Q3 Results/);
    assert.match(html, /data-wid=/, "fresh data-wid anchors were assigned");

    const manifest = loadManifest(dir);
    assert.equal(manifest.head, 1);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].k, "HTML_UPDATED");
    assert.equal(emitted[0].p.version, 1);
    assert.equal(emitted[0].p.prev_version, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyGeneratedDraft rejects an empty draft", async () => {
  const dir = fresh();
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, REQUESTS_DIR), { recursive: true });
    writeFileSync(join(dir, REQUESTS_DIR, GEN_RESPONSE), JSON.stringify({ html: "  " }));
    await assert.rejects(() => applyGeneratedDraft(dir, GEN_RESPONSE, {}), /missing html/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
