import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyFeedback, buildItem, upsertItem, removeItem, clearItems, hasItem, toPayload,
} from "../frontend/src/lib/feedbackStore.js";

test("buildItem keeps only fields valid for the type", () => {
  const c = buildItem({ selector: "a", type: "content-edit", before: "old", value: "new", instruction: "note" });
  assert.deepEqual(c, { selector: "a", type: "content-edit", before: "old", value: "new", instruction: "note" });

  const s = buildItem({ selector: "b", type: "style-edit", style: { color: "#c00" }, classAdd: ["hl"] });
  assert.deepEqual(s, { selector: "b", type: "style-edit", style: { color: "#c00" }, class_add: ["hl"] });
  assert.equal(s.value, undefined, "style-edit carries no value");

  const x = buildItem({ selector: "c", type: "structural-change", instruction: "make it punchy" });
  assert.deepEqual(x, { selector: "c", type: "structural-change", instruction: "make it punchy" });
});

test("upsert replaces the pending edit for a selector (one per block)", () => {
  let s = emptyFeedback;
  s = upsertItem(s, buildItem({ selector: "a", type: "content-edit", value: "v1" }));
  s = upsertItem(s, buildItem({ selector: "a", type: "content-edit", value: "v2" }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].value, "v2");
  assert.ok(hasItem(s, "a"));
});

test("remove and clear", () => {
  let s = emptyFeedback;
  s = upsertItem(s, buildItem({ selector: "a", type: "content-edit", value: "x" }));
  s = upsertItem(s, buildItem({ selector: "b", type: "content-edit", value: "y" }));
  s = removeItem(s, "a");
  assert.deepEqual(s.items.map((i) => i.selector), ["b"]);
  assert.deepEqual(clearItems().items, []);
});

test("toPayload yields the POST body", () => {
  let s = upsertItem(emptyFeedback, buildItem({ selector: "a", type: "content-edit", value: "x" }));
  assert.deepEqual(toPayload(s), { items: [{ selector: "a", type: "content-edit", value: "x" }] });
});
