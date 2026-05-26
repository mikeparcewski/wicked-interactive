import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { instrument } from "../src/core/instrument.js";
import { regenerate } from "../src/core/regenerate.js";

function build() {
  return instrument("<h1>Q2 Results</h1><p>first para</p><p>second para</p>").html;
}

test("content-edit replaces the target's content", async () => {
  const html = build();
  const res = await regenerate(html, {
    items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }],
  });
  assert.deepEqual(res.applied, ["slide-0-heading-1"]);
  const $ = cheerio.load(res.html, null, false);
  assert.equal($('[data-wid="slide-0-heading-1"]').text(), "Q3 Results");
});

test("INV-3: untargeted elements are byte-identical", async () => {
  const html = build();
  const $0 = cheerio.load(html, null, false);
  const beforeP2 = $0.html($0('[data-wid="slide-0-paragraph-2"]'));
  const res = await regenerate(html, {
    items: [{ selector: "slide-0-paragraph-1", type: "content-edit", before: "first para", value: "EDITED" }],
  });
  const $1 = cheerio.load(res.html, null, false);
  const afterP2 = $1.html($1('[data-wid="slide-0-paragraph-2"]'));
  assert.equal(afterP2, beforeP2, "an untargeted element must not change");
});

test("style-edit sets inline style and classes", async () => {
  const html = build();
  const res = await regenerate(html, {
    items: [{
      selector: "slide-0-paragraph-1", type: "style-edit", before: "first para",
      style: { color: "#c00" }, class_add: ["highlight"],
    }],
  });
  const $ = cheerio.load(res.html, null, false);
  const $el = $('[data-wid="slide-0-paragraph-1"]');
  assert.match($el.attr("style"), /color:\s*#c00/);
  assert.ok($el.hasClass("highlight"));
});

test("AC-10: a stale before-snapshot is skipped, not applied", async () => {
  const html = build();
  const res = await regenerate(html, {
    items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "WRONG ORIGINAL", value: "Q3" }],
  });
  assert.deepEqual(res.stale, ["slide-0-heading-1"]);
  assert.deepEqual(res.applied, []);
  assert.match(res.html, />Q2 Results</); // unchanged
});

test("unknown selector is rejected", async () => {
  const res = await regenerate(build(), {
    items: [{ selector: "slide-9-nope-1", type: "content-edit", value: "x" }],
  });
  assert.equal(res.rejected[0].reason, "selector-not-found");
});

test("INV-2: a content-edit that would drop a child data-wid is reverted + rejected", async () => {
  const html = `<p data-wid="slide-0-paragraph-1">outer <span data-wid="child-1">inner</span></p>`;
  const res = await regenerate(html, {
    items: [{ selector: "slide-0-paragraph-1", type: "content-edit", value: "flattened" }],
  });
  assert.deepEqual(res.applied, []);
  assert.match(res.rejected[0].reason, /inv2-would-drop-wids:child-1/);
  assert.match(res.html, /data-wid="child-1"/, "child wid preserved by revert");
});

test("structural-change without an llm is rejected", async () => {
  const res = await regenerate(build(), {
    items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "make it punchy" }],
  });
  assert.equal(res.rejected[0].reason, "structural-change-requires-llm");
});

test("structural-change via llm applies when ids are preserved", async () => {
  const html = build();
  const llm = async (_frag, _instr) => `<h1 data-wid="slide-0-heading-1">Punchy Title</h1>`;
  const res = await regenerate(html, {
    items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchy" }],
  }, { llm });
  assert.deepEqual(res.applied, ["slide-0-heading-1"]);
  assert.match(res.html, />Punchy Title</);
});

test("INV-2: an llm edit that drops the wid is rejected; other items still apply", async () => {
  const html = build();
  const llm = async () => `<h1>no wid here</h1>`; // drops slide-0-heading-1
  const res = await regenerate(html, {
    items: [
      { selector: "slide-0-heading-1", type: "structural-change", instruction: "rewrite" },
      { selector: "slide-0-paragraph-1", type: "content-edit", before: "first para", value: "kept" },
    ],
  }, { llm });
  assert.ok(res.rejected.some((r) => /inv2-llm-dropped-wids/.test(r.reason)));
  assert.ok(res.applied.includes("slide-0-paragraph-1"), "non-offending item still applied");
  assert.match(res.html, /data-wid="slide-0-heading-1"/, "dropped wid preserved by exclusion");
});
