// #247 — deterministic edits apply typed text as TEXT and style values only inside a declared
// property/value grammar. The value comes from the document's editor (or a paste), and the
// result rides into every saved version and every self-contained HTML export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cheerio from "cheerio";
import { instrument } from "../src/core/instrument.js";
import { regenerate } from "../src/core/regenerate.js";
import { initWorkspace, applyFeedbackItems, readVersionHtml } from "../src/service/workspace.js";
import { exportHtml } from "../src/service/export.js";

const H1 = "slide-0-heading-1";
const P1 = "slide-0-paragraph-1";
const build = () => instrument("<h1>Q2 Results</h1><p>first para</p>").html;

test("#247 content-edit with <b>x</b> lands as the literal text, not an element", async () => {
  const res = await regenerate(build(), {
    items: [{ selector: H1, type: "content-edit", before: "Q2 Results", value: "<b>x</b>" }],
  });
  assert.deepEqual(res.applied, [H1]);
  const $ = cheerio.load(res.html, null, false);
  const $h = $(`[data-wid="${H1}"]`);
  assert.equal($h.find("b").length, 0, "no <b> element was created");
  assert.equal($h.text(), "<b>x</b>", "the typed characters are the text");
  assert.match(res.html, /&lt;b&gt;x&lt;\/b&gt;/, "serialized escaped");
});

test("#247 saved version + HTML export: <img onerror> is stored as escaped text only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-247-"));
  try {
    initWorkspace(dir, "<h1>Q2 Results</h1><p>body text</p>");
    const payload = "<img src=x onerror=alert(1)>";
    const r = await applyFeedbackItems(dir, {
      version: 1, parent: 0,
      items: [{ selector: H1, type: "content-edit", before: "Q2 Results", value: payload }],
    });
    assert.equal(r.landed, true);
    const saved = readVersionHtml(dir, 1);
    const $ = cheerio.load(saved);
    assert.equal($("img").length, 0, "no <img> element in the saved version");
    assert.equal($("[onerror]").length, 0, "no onerror attribute in the saved version");
    assert.equal($(`[data-wid="${H1}"]`).text(), payload);

    const out = join(dir, "export.html");
    exportHtml(dir, 1, out);
    const exported = readFileSync(out, "utf-8");
    const $x = cheerio.load(exported);
    assert.equal($x("img").length, 0, "no <img> element in the export");
    assert.equal($x("[onerror]").length, 0, "no onerror attribute in the export");
    assert.ok(!exported.includes("<img"), "the raw tag never appears unescaped");
    assert.ok(exported.includes("&lt;img src=x onerror=alert(1)&gt;"), "present only as escaped text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#247 content-edit keeps the AC-10 stale check", async () => {
  const res = await regenerate(build(), {
    items: [{ selector: H1, type: "content-edit", before: "WRONG", value: "<b>x</b>" }],
  });
  assert.deepEqual(res.stale, [H1]);
  assert.deepEqual(res.applied, []);
});

test("#247 content-edit keeps the wid guard (text over a child anchor is rejected)", async () => {
  const html = `<p data-wid="p">outer <span data-wid="child-1">inner</span></p>`;
  const res = await regenerate(html, {
    items: [{ selector: "p", type: "content-edit", value: `<span data-wid="child-1">x</span>` }],
  });
  assert.deepEqual(res.applied, [], "a markup value can no longer re-create the anchor");
  assert.match(res.rejected[0].reason, /inv2-would-drop-wids:child-1/);
  assert.match(res.html, /<span data-wid="child-1">inner<\/span>/);
});

async function styleEdit(style) {
  return regenerate(build(), { items: [{ selector: P1, type: "style-edit", style }] });
}
const styleOf = (html) => cheerio.load(html, null, false)(`[data-wid="${P1}"]`).attr("style") || "";

test("#247 style-edit with url( is rejected with a reason and changes nothing", async () => {
  const res = await styleEdit({ background: "url(https://example.test/x.png)" });
  assert.deepEqual(res.applied, []);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].selector, P1);
  assert.match(res.rejected[0].reason, /^style-edit-rejected:.*url\(/);
  assert.equal(styleOf(res.html), "");
});

test("#247 style-edit rejects expression(, declaration breakout and undeclared properties", async () => {
  for (const [style, why] of [
    [{ width: "expression(alert(1))" }, /expression\(/],
    [{ color: "red; background: url(x)" }, /value/],
    [{ color: "red}body{color:blue" }, /value/],
    [{ "background-image": "#fff" }, /property/],
    [{ "color;x": "red" }, /property/],
    [{ behavior: "x.htc" }, /property/],
    [{ color: "\\75 rl(x)" }, /value/],
    [{ "font-family": "Archivo, sans-serif", background: "image-set(x)" }, /image-set\(/],
    [{ background: "var(--payload)" }, /var\(/],
  ]) {
    const res = await styleEdit(style);
    assert.deepEqual(res.applied, [], JSON.stringify(style));
    assert.match(res.rejected[0]?.reason ?? "", why, JSON.stringify(style));
    assert.equal(styleOf(res.html), "", `nothing partially applied for ${JSON.stringify(style)}`);
  }
});

test("#247 style-edit inside the grammar still applies", async () => {
  const res = await styleEdit({
    color: "#c00", background: "rgba(0, 0, 0, 0.5)", "font-weight": "bold",
    "font-family": "'Archivo', sans-serif", padding: "4px 8px", "margin-top": "calc(1rem + 2px)",
  });
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.applied, [P1]);
  const s = styleOf(res.html);
  assert.match(s, /color: #c00/);
  assert.match(s, /background: rgba\(0, 0, 0, 0\.5\)/);
  assert.match(s, /margin-top: calc\(1rem \+ 2px\)/);
});

test("#247 studio's Document-mode change-text item (plain text) still lands verbatim", async () => {
  // The exact wire item wicked-studio's e2e/ux2_docfb2_test.py AC3 asserts (feedbackBatch.ts toWireItem).
  const html = instrument('<h1 data-wid="headline">Q2: the quarter we planned</h1>').html;
  const value = "Q3: the quarter we shipped everything";
  const res = await regenerate(html, {
    items: [{ selector: "headline", type: "content-edit", value, before: "Q2: the quarter we planned" }],
  });
  assert.deepEqual(res.applied, ["headline"]);
  assert.match(res.html, /<h1 data-wid="headline">Q3: the quarter we shipped everything<\/h1>/);
});

test("#247 content-edit on a raw-text element (script/style/xmp/…) is rejected, not serialized raw", async () => {
  for (const tag of ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext", "template"]) {
    const html = `<div data-wid="host"><${tag} data-wid="t">old</${tag}></div>`;
    const res = await regenerate(html, {
      items: [{ selector: "t", type: "content-edit", value: `</${tag}><img src=x onerror=alert(1)>` }],
    });
    assert.deepEqual(res.applied, [], tag);
    assert.equal(res.rejected[0]?.reason, `content-edit-raw-text-element:${tag}`, tag);
    assert.ok(!res.html.includes("<img"), `${tag}: payload never serialized`);
  }
});
