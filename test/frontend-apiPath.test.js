import { test } from "node:test";
import assert from "node:assert/strict";
import { apiPath, getCurrentDoc } from "../frontend/src/lib/apiPath.js";

test("getCurrentDoc returns null when ?doc= is absent or malformed", () => {
  assert.equal(getCurrentDoc(""), null);
  assert.equal(getCurrentDoc("?foo=bar"), null);
  assert.equal(getCurrentDoc("?doc=Bad Name"), null);          // not slug-safe
  assert.equal(getCurrentDoc("?doc=-leading-hyphen"), null);   // must start [a-z0-9]
});

test("getCurrentDoc returns a slug-safe name", () => {
  assert.equal(getCurrentDoc("?doc=brochure"), "brochure");
  assert.equal(getCurrentDoc("?doc=my-deck-2"), "my-deck-2");
});

test("apiPath is identity in legacy mode (no doc) — same bundle works in both modes", () => {
  assert.equal(apiPath("/api/versions"), "/api/versions");
  assert.equal(apiPath("/doc/5"), "/doc/5");
  assert.equal(apiPath("/events"), "/events");
});

test("apiPath prefixes with /d/<doc>/ when a doc is supplied", () => {
  assert.equal(apiPath("/api/versions", "brochure"), "/d/brochure/api/versions");
  assert.equal(apiPath("/doc", "deck"), "/d/deck/doc");
  assert.equal(apiPath("/events", "x"), "/d/x/events");
});

test("apiPath does not double-prefix already-scoped paths", () => {
  assert.equal(apiPath("/d/brochure/api/versions", "brochure"), "/d/brochure/api/versions");
});
