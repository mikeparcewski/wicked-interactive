import { test } from "node:test";
import assert from "node:assert/strict";
import { instrument, collectWids, unanchoredTextBlocks } from "../src/core/instrument.js";

test("injects unique data-wid on reviewable blocks", () => {
  const { html, ids } = instrument("<h1>Title</h1><p>One</p><p>Two</p>");
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "ids must be unique");
  assert.match(html, /data-wid="slide-0-heading-1"/);
  assert.match(html, /data-wid="slide-0-paragraph-1"/);
  assert.match(html, /data-wid="slide-0-paragraph-2"/);
});

test("format is slide-{n}-{role}-{ordinal} and ordinals reset per slide", () => {
  const html = `<section><p>a</p></section><section><p>b</p><p>c</p></section>`;
  const { ids } = instrument(html);
  assert.deepEqual(ids, [
    "slide-0-paragraph-1",
    "slide-1-paragraph-1",
    "slide-1-paragraph-2",
  ]);
});

test("preserves a pre-existing data-wid (INV-1 stability)", () => {
  const { html, ids } = instrument(`<p data-wid="custom-anchor">keep me</p><p>new</p>`);
  assert.ok(ids.includes("custom-anchor"), "existing id retained");
  assert.match(html, /data-wid="custom-anchor"/);
  // The new paragraph still gets one, and it must not collide.
  assert.equal(new Set(ids).size, ids.length);
});

test("collectWids returns ids in document order", () => {
  const { html } = instrument("<h1>t</h1><p>p</p>");
  assert.deepEqual(collectWids(html), ["slide-0-heading-1", "slide-0-paragraph-1"]);
});

test("inline text INSIDE an anchored block gets no anchor of its own; bare text beside blocks does (F-RECON-004)", () => {
  // The `<b>` lives in an anchored paragraph → the paragraph is its anchor.
  const inside = instrument(`<p>Hello <b>world</b></p>`).html;
  assert.doesNotMatch(inside, /<b data-wid/);
  assert.match(inside, /<p data-wid="slide-0-paragraph-1"/);
  // A span whose text has NO anchored block around it is a text block in its own right — before
  // this it was un-pinnable, and a comment on it resolved to whatever anchored block was nearest.
  const { html } = instrument(`<div><span>x</span><p>y</p></div>`);
  assert.match(html, /<span data-wid="slide-0-text-1">x<\/span>/);
  assert.match(html, /<p data-wid="slide-0-paragraph-1"/);
  assert.doesNotMatch(html, /<div data-wid/, "the container holds a block child with text — it is a container, not a text block");
  assert.deepEqual(unanchoredTextBlocks(html), []);
});

// ── F-RECON-004: every text block is anchorable ────────────────────────────────────────────
// The recon brochure's hero fact strip (`div > span…`), footer requirements block, flow badges
// and KPI-style tiles carried no data-wid, so a design pin on the strip resolved to the hero
// paragraph and the edit landed on the wrong block. These fixtures mirror those exact shapes.

const BROCHURE = `
<header class="hero">
  <h1>wicked-studio</h1>
  <p class="hero-desc">The agent IDE.</p>
  <div class="fact-strip"><span>Works with Claude Code</span> · <span>Antigravity</span> · <span>MIT licensed</span></div>
</header>
<section class="pillars">
  <article class="pillar"><h2>Direct</h2><ul><li>› runs</li><li>› gates</li></ul></article>
  <div class="kpi"><div class="v">12</div><div class="k">Runs today</div></div>
</section>
<section class="flow-section" aria-labelledby="flow-heading">
  <h2 id="flow-heading">Flow</h2>
  <div class="flow-diagram" role="img" aria-label="Five-stage run flow">
    <div class="flow-node"><div class="flow-glyph" aria-hidden="true">◇</div><div class="flow-label">Intent</div><div class="flow-status st-done">done</div></div>
    <div class="flow-connector" aria-hidden="true"></div>
    <div class="flow-node"><div class="flow-glyph" aria-hidden="true">▸</div><div class="flow-label">Council</div><div class="flow-status st-running">running</div></div>
  </div>
  <figure><img src="x.png" alt="chart"><figcaption>Fig 1</figcaption></figure>
  <table><tr><th>Seat</th><td>claude</td></tr></table>
  <pre><code>npx wicked-crew serve</code></pre>
  <blockquote>Quote</blockquote>
  <span class="spec-badge">beta</span>
  <div class="decor" data-wi-no-anchor>ornament</div>
</section>
<section class="cta">
  <p>Get started</p>
  <div class="cta-reqs"><span>Requires</span><br><span>Node 20+</span></div>
  <div class="mixed">Intro text <p>with a paragraph</p></div>
</section>`;

test("every block with visible text in a brochure-shaped document has an anchor of its own (F-RECON-004)", () => {
  const { html } = instrument(BROCHURE);
  // Nothing with words on it is left un-pinnable — except the author's explicit opt-out.
  const left = unanchoredTextBlocks(html);
  assert.deepEqual(left, [left.find((l) => /data-wi-no-anchor/.test(l))].filter(Boolean), JSON.stringify(left));
  // The recon's exact culprits are now first-class anchors: the strip (not its spans), the
  // requirements block, each flow label/status (not the decorative glyph), each KPI cell.
  // (Slide indices: `header` is not a slide container, so the hero shares slide 0 with the
  // first `section`; the flow section is slide 1, the CTA slide 2.)
  assert.match(html, /<div class="fact-strip" data-wid="slide-0-block-1">/);
  assert.doesNotMatch(html, /<span data-wid="[^"]*">Works with Claude Code/, "strip spans ride on the strip's anchor");
  assert.match(html, /<div class="cta-reqs" data-wid="slide-2-block-1">/);
  assert.match(html, /<div class="flow-label" data-wid="slide-1-block-1">Intent/);
  assert.match(html, /<div class="flow-status st-done" data-wid="slide-1-block-2">done/);
  assert.match(html, /<div class="flow-label" data-wid="slide-1-block-3">Council/);
  assert.doesNotMatch(html, /<div class="flow-glyph" aria-hidden="true" data-wid/, "aria-hidden glyphs are decorative");
  assert.doesNotMatch(html, /<div class="flow-node" data-wid/, "a container of text blocks is not itself a block");
  assert.doesNotMatch(html, /<div class="flow-diagram"[^>]*data-wid/);
  assert.match(html, /<div class="v" data-wid="slide-0-block-2">12/);
  assert.match(html, /<div class="k" data-wid="slide-0-block-3">Runs today/);
  assert.doesNotMatch(html, /<div class="kpi" data-wid/);
  // Semantic tags keep their semantic ids (the new pass has its own counters).
  assert.match(html, /<h1 data-wid="slide-0-heading-1">/);
  assert.match(html, /<p class="hero-desc" data-wid="slide-0-paragraph-1">/);
  assert.match(html, /<li data-wid="slide-0-list-item-1">/);
  assert.match(html, /<figcaption data-wid="slide-1-caption-1">/);
  assert.match(html, /<td data-wid="slide-1-cell-2">/);
  assert.match(html, /<blockquote data-wid="slide-1-quote-1">/);
  // Containers whose text lives in block children are NOT anchored (table/tr/figure/ul/article).
  for (const tag of ["table", "tr", "figure", "ul", "article"]) assert.doesNotMatch(html, new RegExp(`<${tag}[^>]*data-wid=`), tag);
  // Block-level text holders that are not semantic tags become `block`; inline ones `text`.
  assert.match(html, /<pre data-wid="slide-1-block-5">/);
  assert.match(html, /<span class="spec-badge" data-wid="slide-1-text-1">/);
  // A div with its OWN text and a block child is anchored (its own words need a home); the child keeps its anchor.
  assert.match(html, /<div class="mixed" data-wid="slide-2-block-2">Intro text <p data-wid="slide-2-paragraph-2">/);
  // Sections/headers stay in the section namespace, never a block id.
  assert.match(html, /<header class="hero" data-wid="section-0">/);
  assert.doesNotMatch(html, /<section[^>]*data-wid="slide-/);
  // Opt-out honoured.
  assert.match(html, /<div class="decor" data-wi-no-anchor(="")?>ornament/);
});

test("the text-block pass is stable: re-instrumenting an instrumented document changes nothing (INV-1)", () => {
  const once = instrument(BROCHURE).html;
  const twice = instrument(once);
  assert.equal(twice.html, once);
  assert.equal(new Set(collectWids(once)).size, collectWids(once).length, "ids unique");
});

test("a pre-existing text-block anchor is preserved and new siblings never collide with it (INV-1)", () => {
  const { html, ids } = instrument(`<div data-wid="slide-0-block-1"><span>kept</span></div><div><span>new</span></div>`);
  assert.match(html, /<div data-wid="slide-0-block-1"><span>kept<\/span><\/div><div data-wid="slide-0-block-2"><span>new<\/span><\/div>/);
  assert.equal(new Set(ids).size, ids.length);
});

test("anchors section/header containers with section-{i} (ADR-0011, additive)", () => {
  const { html, ids, sectionIds } = instrument('<header class="hero"><h1>T</h1></header><section><p>x</p></section>');
  assert.deepEqual(sectionIds, ["section-0", "section-1"]);
  assert.match(html, /<header[^>]*data-wid="section-0"/);
  assert.match(html, /<section[^>]*data-wid="section-1"/);
  // block ids are still assigned and unchanged by the section pass
  assert.ok(ids.includes("slide-0-heading-1"));
  assert.equal(new Set([...ids, ...sectionIds]).size, ids.length + sectionIds.length, "no id collisions");
});

test("existing ids preserved when sections are added (INV-1)", () => {
  const { ids, sectionIds } = instrument('<section data-wid="my-section"><p data-wid="keep">x</p></section>');
  assert.ok(ids.includes("keep"));
  assert.ok(sectionIds.includes("my-section"), "pre-existing section anchor preserved");
});
