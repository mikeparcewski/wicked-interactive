// events.test.js — locks the event vocabulary contract (ADR-0019).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DOMAIN, PRODUCERS, EVENT_TYPES, ALL_FILTER,
  isKnownType, ownerOf, subdomainOf, uiEmittable, canEmit,
} from "../src/service/events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "../src/service/event-schemas");

test("domain is the package name and the all-filter targets it", () => {
  assert.equal(DOMAIN, "wicked-interactive");
  assert.equal(ALL_FILTER, "*@wicked-interactive");
});

test("every event_type follows wicked.<noun>.<past-verb> and has a known producer", () => {
  for (const [type, def] of Object.entries(EVENT_TYPES)) {
    assert.match(type, /^wicked\.[a-z0-9]+\.[a-z0-9]+$/, `${type} shape`);
    assert.ok(def.subdomain && /^[a-z.]+$/.test(def.subdomain), `${type} subdomain`);
    assert.ok(Array.isArray(def.owners) && def.owners.length > 0, `${type} owners`);
    for (const o of def.owners) {
      assert.ok(Object.values(PRODUCERS).includes(o), `${type} owner ${o} is a known producer`);
    }
  }
});

test("ownership table gates emits by producer", () => {
  assert.ok(canEmit("wicked.interactive.version.created", PRODUCERS.SERVICE));
  assert.ok(!canEmit("wicked.interactive.version.created", PRODUCERS.UI));
  assert.ok(canEmit("wicked.interactive.edit.completed", PRODUCERS.AGENT));
  assert.ok(!canEmit("wicked.interactive.edit.completed", PRODUCERS.SERVICE));
  // chat is dual-owned: both UI and agent may post.
  assert.ok(canEmit("wicked.interactive.chat.posted", PRODUCERS.UI));
  assert.ok(canEmit("wicked.interactive.chat.posted", PRODUCERS.AGENT));
  assert.ok(!canEmit("wicked.interactive.chat.posted", PRODUCERS.SERVICE));
  assert.deepEqual(ownerOf("wicked.unknown.thing"), []);
});

test("UI may only originate the conversational/intent events", () => {
  const uiYes = ["wicked.interactive.feedback.submitted", "wicked.interactive.chat.posted", "wicked.interactive.question.answered",
    "wicked.interactive.source.attached", "wicked.interactive.demo.requested", "wicked.interactive.theme.requested", "wicked.interactive.review.requested"];
  const uiNo = ["wicked.interactive.edit.completed", "wicked.interactive.draft.completed", "wicked.interactive.version.created",
    "wicked.interactive.feedback.processed", "wicked.interactive.status.posted", "wicked.interactive.doc.created",
    "wicked.interactive.source.updated", "wicked.interactive.export.requested", "wicked.interactive.error.raised", "wicked.interactive.theme.learned",
    "wicked.interactive.review.completed"];
  for (const t of uiYes) assert.ok(uiEmittable(t), `${t} should be UI-emittable`);
  for (const t of uiNo) assert.ok(!uiEmittable(t), `${t} should NOT be UI-emittable`);
});

test("helpers reject unknown types", () => {
  assert.ok(!isKnownType("wicked.bogus.happened"));
  assert.throws(() => subdomainOf("wicked.bogus.happened"), /unknown event type/);
  assert.ok(!uiEmittable("wicked.bogus.happened"));
});

test("every event_type has a JSON Schema file and every schema is valid JSON", () => {
  assert.ok(existsSync(SCHEMA_DIR), "event-schemas/ dir exists");
  const files = new Set(readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json")));
  for (const type of Object.keys(EVENT_TYPES)) {
    const fname = `${type}.json`;
    assert.ok(files.has(fname), `schema file missing for ${type}`);
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, fname), "utf-8"));
    assert.equal(schema.type, "object", `${fname} schema is an object schema`);
    assert.ok(Array.isArray(schema.required), `${fname} declares required[]`);
    assert.ok(schema.required.includes("document_id"), `${fname} requires document_id`);
  }
  // No orphan schema files (every schema maps to a known type).
  for (const f of files) {
    const type = f.replace(/\.json$/, "");
    assert.ok(isKnownType(type), `orphan schema ${f} has no event type`);
  }
});
