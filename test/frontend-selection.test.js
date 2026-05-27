import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestReviewable, describe } from "../frontend/src/lib/selection.js";

// Minimal DOM-ish stub: { tagName, attrs, textContent, parentElement }.
function el(tagName, attrs = {}, textContent = "", parentElement = null) {
  return {
    tagName,
    textContent,
    parentElement,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}

test("nearestReviewable climbs to the closest data-wid ancestor", () => {
  const p = el("P", { "data-wid": "slide-0-paragraph-1" }, "hi");
  const span = el("SPAN", {}, "hi", p);
  const text = el("#text", {}, "hi", span);
  assert.equal(nearestReviewable(text), p);
});

test("nearestReviewable returns null when no anchor is found", () => {
  const div = el("DIV", {}, "x");
  assert.equal(nearestReviewable(div), null);
});

test("describe extracts selector, tag, and a normalized before-snapshot", () => {
  const d = describe(el("H1", { "data-wid": "slide-0-heading-1" }, "  Q2   Results \n"));
  assert.deepEqual(d, { selector: "slide-0-heading-1", tag: "h1", before: "Q2 Results", section: null });
});

test("describe returns null for an element without data-wid", () => {
  assert.equal(describe(el("P", {}, "x")), null);
});

test("describe reports the nearest section anchor (ADR-0011)", () => {
  const section = el("SECTION", { "data-wid": "section-0" }, "", null);
  const p = el("P", { "data-wid": "slide-0-paragraph-1" }, "hi", section);
  assert.equal(describe(p).section, "section-0");
});

test("describe section is null when there is no enclosing section", () => {
  const p = el("P", { "data-wid": "slide-0-paragraph-1" }, "hi", null);
  assert.equal(describe(p).section, null);
});
