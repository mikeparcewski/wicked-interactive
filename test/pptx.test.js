// pptx.test.js — native PowerPoint export, built in Node (ADR-0020, interactive#322). No Python and no
// skip: every environment builds a real .pptx, and an independent reader (fixtures/read-pptx.js, node:zlib)
// proves it is a well-formed zip whose slides carry the deck's titles, text and speaker notes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace } from "../src/service/workspace.js";
import * as cheerio from "cheerio";
import { buildPptx, exportPptx, extractSlides, pptxTheme, toPptxColor } from "../src/service/pptx.js";
import { topSlides } from "../src/core/deck.js";
import { resolveThemeTokens, themed } from "../src/service/theme-source.js";
import { checkXml, readPptx, readZip } from "./fixtures/read-pptx.js";

const SAMPLE = [
  '<section><h1>Q3 &amp; Results</h1><p>Revenue grew 18%.</p><ul><li>Margin held</li><li>Churn fell</li></ul>',
  '<aside class="notes" data-notes-for="x" hidden>Say the number slowly.</aside></section>',
  '<section><h2>How a run works</h2><div class="steps"><div class="step"><b>1. Page</b>\n<span>Split into pages.</span></div>',
  '<div class="step"><b>2. Review</b> <span>A reviewer can send it back.</span></div></div>',
  "<table><tr><th>Function</th><th>Does</th></tr><tr><td>sum(xs)</td><td>Adds every element.</td></tr></table>",
  '<p class="foot">Source: brief</p></section>',
  "<section><h2>Next</h2><p>Hire two AEs.</p></section>",
].join("");

function ws(html = SAMPLE, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wi-pptx-"));
  initWorkspace(dir, html, { style: "ppt", ...opts });
  return dir;
}

test("a sample deck exports a valid .pptx: one slide per slide, titles, body text and speaker notes", async () => {
  const dir = ws();
  try {
    const { path, bytes, slides } = await exportPptx(dir, 0);
    assert.match(path, /_v0\.pptx$/);
    const buf = readFileSync(path);
    assert.equal(bytes, buf.length);
    assert.equal(slides, 3);
    const { files, slides: read } = readPptx(buf);
    assert.equal([...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).length, 3);
    assert.deepEqual(read.map((s) => s.texts[0]), ["Q3 & Results", "How a run works", "Next"]);
    assert.deepEqual(read[0].texts[1].split("\n"), ["Revenue grew 18%.", "Margin held", "Churn fell"]);
    assert.equal(read[0].notes, "Say the number slowly.");
    assert.ok(!read[0].texts.join(" ").includes("Say the number"), "notes never land on the slide");
    // Loose text in cards and table rows is slide content too: nothing visible is dropped.
    const body = read[1].texts.slice(1).join("\n");
    for (const t of ["1. Page Split into pages.", "2. Review A reviewer can send it back.", "Function | Does", "sum(xs) | Adds every element.", "Source: brief"]) {
      assert.ok(body.includes(t), `${t} in ${body}`);
    }
    assert.equal(read[1].notes, "");
    assert.equal(read[2].texts[1], "Hire two AEs.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exportPptx on a missing version throws", async () => {
  const dir = ws();
  try {
    await assert.rejects(exportPptx(dir, 99), /version 99 not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the reader is strict: a truncated file is not a valid package", async () => {
  const { bytes } = await buildPptx(SAMPLE);
  assert.throws(() => readZip(bytes.subarray(0, bytes.length - 40)));
});

test("a document with no slide containers is one slide; an empty one is a single Untitled slide", () => {
  assert.deepEqual(extractSlides("<h1>Memo</h1><p>One</p><p>Two</p>").map((s) => s.title), ["Memo"]);
  assert.deepEqual(extractSlides("<div></div>"), [{ title: "Untitled", blocks: [], notes: "" }]);
});

test("scripts, styles and hidden elements are not slide text; a hidden notes aside still is notes", () => {
  const [s] = extractSlides('<section><style>h1{color:red}</style><script>var x = 1</script><h1>T</h1><p hidden>secret</p><p>shown</p><aside class="notes" data-notes-for="a" hidden>n</aside></section>');
  assert.deepEqual(s, { title: "T", blocks: [["para", "shown"]], notes: "n" });
});

test("two notes asides on one slide are both kept", () => {
  const [s] = extractSlides('<section><h1>T</h1><aside class="notes" data-notes-for="a" hidden>one</aside><aside class="notes" data-notes-for="a" hidden>two</aside></section>');
  assert.equal(s.notes, "one\ntwo");
});

test("the deck is drawn in the exported version's own theme, not a fixed default", async () => {
  const purple = themed("<section><h1>A</h1><p>b</p></section>", { tokens: resolveThemeTokens("midnight-purple") });
  assert.deepEqual(pptxTheme(purple), { bg: "0A0A0F", primary: "A100FF", accent: "F59E0B", text: "FFFFFF", headingFont: "Calibri", bodyFont: "Calibri" });
  const { bytes } = await buildPptx(purple);
  assert.match(readZip(bytes).get("ppt/slides/slide1.xml").toString(), /<a:srgbClr val="0A0A0F"/i);
  // No theme block at all: the default theme's colours.
  assert.equal(pptxTheme("<section><h1>A</h1></section>").bg, "FFFFFF");
});

test("theme colours in every grammar form become PowerPoint hex; translucent ones are composited; anything else falls back", () => {
  assert.equal(toPptxColor("#abc"), "AABBCC");
  assert.equal(toPptxColor("#112233"), "112233");
  assert.equal(toPptxColor("rgb(255, 0, 10)"), "FF000A");
  assert.equal(toPptxColor("rgb(50%, 0%, 100%)"), "8000FF", "50% is 128, rounded correctly");
  assert.equal(toPptxColor("hsl(120, 100%, 25%)"), "008000");
  // Alpha is composited over what is under it (white by default), never dropped.
  assert.equal(toPptxColor("rgba(255, 0, 0, 0)"), "FFFFFF");
  assert.equal(toPptxColor("rgba(0, 0, 0, 0.5)"), "808080");
  assert.equal(toPptxColor("#00000080"), "7F7F7F");
  assert.equal(toPptxColor("var(--wi-x)"), null);
  // Text colours are composited over the deck's background: a transparent text token can't vanish onto it.
  const t = pptxTheme('<style data-wi-theme="t">:root:root{--wi-bg:#000000;--wi-text:rgba(255,255,255,0.5);}</style><h1>A</h1>');
  assert.equal(t.text, "808080");
  // A token that names another token resolves through it.
  assert.equal(pptxTheme('<style data-wi-theme="t">:root:root{--wi-accent:#123456;--wi-primary:var(--wi-accent);}</style><h1>A</h1>').primary, "123456");
});

// ── codex r1 (deck-style-pptx): slide count, visibility, text fidelity, XML validity ───────────────

const coreCount = (html) => topSlides(cheerio.load(html)).length;

test("every slide core/deck.js counts is exported, whatever wraps it: a block, a hidden wrapper, an inline slide", async () => {
  for (const html of [
    "<blockquote><section><h1>A</h1></section><section><h1>B</h1></section></blockquote>",
    "<div hidden><section><h1>A</h1></section></div><section><h1>B</h1></section>",
    '<p><span class="slide"><b>A</b></span></p><section><h1>B</h1></section>',
    '<li><section><h1>A</h1><p>a</p></section></li><li><section><h1>B</h1></section></li>',
  ]) {
    const n = coreCount(html);
    assert.equal(n, 2, html);
    assert.equal(extractSlides(html).length, n, html);
    const { bytes, slides } = await buildPptx(html);
    assert.equal(slides, n, html);
    assert.equal(readPptx(bytes).slides.length, n, html);
  }
  assert.deepEqual(extractSlides("<blockquote><section><h1>A</h1></section><section><h1>B</h1></section></blockquote>").map((s) => s.title), ["A", "B"]);
  // A hidden slide, or one in a hidden wrapper, is kept (core counts it) but blank: nothing a reader can't see is
  // slide text. Its speaker notes are still its notes.
  const [a] = extractSlides('<div hidden><p>leak</p><section><h1>confidential</h1><p>a body</p>' +
    '<aside class="notes" data-notes-for="a" hidden>its notes</aside></section></div><section><h1>B</h1></section>');
  assert.deepEqual(a, { title: null, blocks: [], notes: "its notes" });
  const [h] = extractSlides('<section hidden><h1>confidential</h1></section><section><h1>B</h1></section>');
  assert.deepEqual(h, { title: null, blocks: [], notes: "" });
});

test("only what a reader sees is slide text: no head title, hidden copy, SVG title/desc or canvas fallback", () => {
  const [s] = extractSlides('<html><head><title>Browser tab</title></head><body><section><h1>T</h1>' +
    '<p style="color:red; display: none">secret</p><p style="visibility:hidden">ghost</p>' +
    '<svg><title>svg label</title><desc>svg description</desc><text>chart label</text></svg>' +
    "<canvas>fallback copy</canvas><p>shown</p></section></body></html>");
  assert.equal(s.title, "T");
  assert.deepEqual(s.blocks, [["para", "chart label"], ["para", "shown"]]);
});

test("text keeps its authored shape: adjacency, line breaks, preformatted lines, table rows", () => {
  const [s] = extractSlides("<section><h1>T</h1><div>1<span>0</span> items</div><p><b>1</b><span>0</span>% growth</p>" +
    "<div><b>1. Page</b>\n  <span>Split it.</span></div><p>Revenue\n  grew 18%.</p>" +
    "<p>line one<br>line two</p><pre>  x = 1\n    y = 2</pre><table><tr><th>A</th><th>B</th></tr></table>" +
    '<aside class="notes" data-notes-for="x" hidden><p>Note one.</p><p>Note two.</p></aside></section>');
  assert.deepEqual(s.blocks, [
    ["para", "10 items"], ["para", "10% growth"], ["para", "1. Page Split it."], ["para", "Revenue grew 18%."],
    ["para", "line one\nline two"], ["para", "  x = 1\n    y = 2"], ["para", "A | B"],
  ]);
  assert.equal(s.notes, "Note one.\nNote two.");
});

test("characters XML 1.0 forbids never reach the package; the reader refuses them, a stray & and a bad CRC", async () => {
  const html = '<section><h1>A\u0001B</h1><p>x\u0003y</p><aside class="notes" data-notes-for="a" hidden>n\u0002o</aside></section>';
  const { bytes } = await buildPptx(html);
  const [slide] = readPptx(bytes).slides; // throws on a forbidden character in any part
  assert.deepEqual(slide.texts, ["AB", "xy"]);
  assert.equal(slide.notes, "no");
  assert.throws(() => checkXml("t", "<a:t>bad\u0001</a:t>"), /forbids/);
  assert.throws(() => checkXml("t", "<a><b></a></b>"), /closes nothing/);
  assert.throws(() => checkXml("t", "<a>R&D</a>"), /unescaped/);
  // Flip one byte inside a non-empty entry's compressed data, headers intact: only the CRC can catch it.
  const broken = Buffer.from(bytes);
  let at = 0;
  for (;;) {
    const csize = broken.readUInt32LE(at + 18), start = at + 30 + broken.readUInt16LE(at + 26) + broken.readUInt16LE(at + 28);
    const name = broken.subarray(at + 30, at + 30 + broken.readUInt16LE(at + 26)).toString();
    if (csize > 16 && broken.readUInt16LE(at + 8) === 0 && name.endsWith(".xml")) { broken[start + 8] ^= 0x20; break; }
    at = start + csize;
  }
  assert.throws(() => readZip(broken), /CRC mismatch/);
});

test("preformatted text goes through the same filters, keeps its breaks, and a marker-like character survives", () => {
  const [s] = extractSlides('<section><h1>T</h1><pre>a<span hidden>secret</span>b<br>c' +
    '<aside class="notes" data-notes-for="x" hidden>n</aside></pre><p>a\uE000b\uE001c</p></section>');
  assert.deepEqual(s.blocks, [["para", "ab\nc"], ["para", "a\uE000b\uE001c"]]);
  assert.equal(s.notes, "n", "a note inside <pre> is the slide's notes, once");
});

test("a form control's visible value is slide text; SVG definitions are not; a reused <text> is read where it is defined", () => {
  const [s] = extractSlides('<section><h1>T</h1><p>Name: <input value="Ada"> <input type="hidden" value="x"> <input type="password" value="abc"></p>' +
    '<p>Plan: <select><option>Free</option><option selected>Paid</option></select></p><p>Tier: <select><option>Basic</option><option>Pro</option></select></p>' +
    '<svg><defs><text id="u">unused</text></defs><text>painted</text></svg></section>');
  assert.deepEqual(s.blocks, [["para", "Name: Ada \u2022\u2022\u2022"], ["para", "Plan: Paid"], ["para", "Tier: Basic"], ["para", "painted"]]);
});

test("a heading inside a quote is still the slide's title; a hidden page shows no slide text", () => {
  const [q] = extractSlides("<section><blockquote><h1>Customer story</h1><p>We saved 20%.</p></blockquote></section>");
  assert.deepEqual(q, { title: "Customer story", blocks: [["para", "We saved 20%."]], notes: "" });
  for (const html of ["<body hidden><section><h1>secret</h1></section></body>", '<html style="display:none"><body><section><h1>secret</h1></section></body></html>']) {
    assert.deepEqual(extractSlides(html), [{ title: null, blocks: [], notes: "" }], html);
  }
});

test("a font name that isn't a plain family never reaches the XML; long token chains resolve, cycles fall back", async () => {
  const theme = (css) => `<style data-wi-theme="t">:root:root{${css}}</style><section><h1>A</h1><p>b</p></section>`;
  const odd = theme(`--wi-font-heading:"Rock & Roll";--wi-font-body:'A "B"';`);
  assert.deepEqual([pptxTheme(odd).headingFont, pptxTheme(odd).bodyFont], ["Calibri", "Calibri"]);
  readPptx((await buildPptx(odd)).bytes); // well-formed
  const names = ["--wi-primary", "--wi-secondary", "--wi-accent", "--wi-text", "--wi-text-secondary", "--wi-muted", "--wi-border",
    "--wi-surface", "--wi-card-bg", "--wi-success", "--wi-warning"];
  const chain = names.map((n, i) => `${n}:${i + 1 < names.length ? `var(${names[i + 1]})` : "#123456"};`).join("");
  assert.equal(pptxTheme(theme(chain)).primary, "123456");
  assert.equal(pptxTheme(theme("--wi-primary:var(--wi-accent);--wi-accent:var(--wi-primary);")).primary, "1E3A5F");
});

test("codex r4: hidden selects stay hidden; single-line <pre> and <textarea> keep their whitespace; notes keep blank lines", () => {
  const [s] = extractSlides('<section><h1>T</h1><p>Shown <select hidden><option>secret</option></select>' +
    '<select style="display:none"><option>secret2</option></select></p><pre>  x = 1  </pre><textarea>Line 1\nLine 2</textarea>' +
    '<pre>  a\n\n  b  </pre><aside class="notes" data-notes-for="x" hidden>One\n\nTwo</aside></section>');
  assert.deepEqual(s.blocks, [["para", "Shown"], ["para", "  x = 1  "], ["para", "Line 1\nLine 2"], ["para", "  a\n\n  b  "]]);
  assert.equal(s.notes, "One\n\nTwo");
});

test("the builder loads pptxgenjs's CommonJS build (an older Node can't load its ESM file as CommonJS)", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--no-experimental-detect-module", "--input-type=module", "-e",
    'import { buildPptx } from "./src/service/pptx.js"; const { slides } = await buildPptx("<section><h1>A</h1></section>"); console.log(slides);'],
  { encoding: "utf-8", cwd: new URL("..", import.meta.url) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1");
});
