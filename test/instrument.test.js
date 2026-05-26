import { test } from "node:test";
import assert from "node:assert/strict";
import { instrument, collectWids } from "../src/core/instrument.js";

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

test("non-reviewable elements get no data-wid", () => {
  const { html } = instrument(`<div><span>x</span><p>y</p></div>`);
  assert.doesNotMatch(html, /<span data-wid/);
  assert.match(html, /<p data-wid="slide-0-paragraph-1"/);
});
