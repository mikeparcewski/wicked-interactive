import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedback, serializeFeedback } from "../src/core/feedback-schema.js";

const SAMPLE = `---
version: 1
base_html: _v0.html
timestamp: 2026-05-26T18:00:00Z
---

## item: slide-0-heading-1
- type: content-edit
- instruction: Rename the title
- before: Q2 Results
- value: Q3 Results

## item: slide-0-paragraph-1
- type: style-edit
- before: lorem
- style: { color: "#cc0000" }
- class_add: [highlight]
`;

test("parses frontmatter and items", () => {
  const { frontmatter, items } = parseFeedback(SAMPLE);
  assert.equal(frontmatter.version, 1);
  assert.equal(frontmatter.base_html, "_v0.html");
  assert.equal(items.length, 2);
  assert.equal(items[0].selector, "slide-0-heading-1");
  assert.equal(items[0].type, "content-edit");
  assert.equal(items[0].value, "Q3 Results");
  assert.equal(items[0].before, "Q2 Results");
});

test("parses structured style + class fields", () => {
  const { items } = parseFeedback(SAMPLE);
  assert.deepEqual(items[1].style, { color: "#cc0000" });
  assert.deepEqual(items[1].class_add, ["highlight"]);
});

test("accepts a remove item (no extra fields required)", () => {
  const { items } = parseFeedback(`---
version: 1
---

## item: slide-3-link-1
- type: remove
`);
  assert.equal(items[0].type, "remove");
  assert.equal(items[0].selector, "slide-3-link-1");
});

test("rejects an invalid type", () => {
  assert.throws(() => parseFeedback(`---
version: 1
---

## item: x
- type: teleport
`), /invalid type/);
});

test("content-edit without value is rejected", () => {
  assert.throws(() => parseFeedback(`---
version: 1
---

## item: x
- type: content-edit
- instruction: do something
`), /missing 'value'/);
});

test("structural-change without instruction is rejected", () => {
  assert.throws(() => parseFeedback(`---
version: 1
---

## item: x
- type: structural-change
`), /missing 'instruction'/);
});

test("missing frontmatter throws", () => {
  assert.throws(() => parseFeedback(`## item: x\n- type: content-edit\n- value: y`), /frontmatter/);
});

test("round-trips through serialize -> parse", () => {
  const parsed = parseFeedback(SAMPLE);
  const reparsed = parseFeedback(serializeFeedback(parsed));
  assert.equal(reparsed.items.length, 2);
  assert.equal(reparsed.items[0].value, "Q3 Results");
  assert.deepEqual(reparsed.items[1].class_add, ["highlight"]);
});
