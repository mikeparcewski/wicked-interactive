import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, loadManifest, readVersionHtml } from "../src/service/workspace.js";
import { applyGeneratedHtml, generationPlaceholder } from "../src/service/generation.js";

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

test("generationPlaceholder describes a brief-only build (no source paths)", () => {
  const html = generationPlaceholder("teaser", [], "A punchy one-pager <for> launch");
  assert.match(html, /your brief/);
  assert.doesNotMatch(html, /0 locations/);     // no "0 locations" artifact
  assert.match(html, /<blockquote>/);            // the brief is shown back
  assert.match(html, /&lt;for&gt;/);             // brief is HTML-escaped
  assert.doesNotMatch(html, /<for>/);            // no raw injection
});

test("applyGeneratedHtml lands the draft as v1 with fresh anchors", async () => {
  const dir = fresh();
  try {
    // The agent's draft: a full document with no anchors.
    const draft = "<section><h1>Q3 Results</h1><p>Revenue up 40%.</p></section>";
    const { version, parent } = await applyGeneratedHtml(dir, draft, { documentId: "my-deck" });

    assert.equal(parent, 0, "parent is the placeholder v0");
    assert.equal(version, 1, "draft lands as v1");

    const html = readVersionHtml(dir, 1);
    assert.match(html, /Q3 Results/);
    assert.match(html, /data-wid=/, "fresh data-wid anchors were assigned");
    assert.equal(loadManifest(dir).head, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("applyGeneratedHtml rejects an empty draft", async () => {
  const dir = fresh();
  try {
    await assert.rejects(() => applyGeneratedHtml(dir, "  ", {}), /missing html/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
