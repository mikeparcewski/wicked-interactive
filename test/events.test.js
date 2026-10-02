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

test("every event_type follows wicked.<domain>.<noun>.<past-verb> and has a known producer", () => {
  for (const [type, def] of Object.entries(EVENT_TYPES)) {
    assert.match(type, /^wicked\.[a-z0-9]+\.[a-z0-9]+\.[a-z0-9_]+$/, `${type} shape`);
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
  // The unmake verb (#189) is service-owned, exactly like doc.created.
  assert.ok(canEmit("wicked.interactive.doc.retired", PRODUCERS.SERVICE));
  assert.ok(!canEmit("wicked.interactive.doc.retired", PRODUCERS.UI));
  assert.ok(!canEmit("wicked.interactive.doc.retired", PRODUCERS.AGENT));
});

test("crew (wi-crew) is a governed answerer: drafts + structural edits + status (Phase 7c)", () => {
  // THE one list: the additive rows let crew land first drafts (spike), fulfil structural
  // handoffs (final leg — edit.completed, after the Project-model ADR), and narrate progress —
  // and NOTHING else; the browser can never impersonate crew (no uiEmittable widening).
  const crewOwned = new Set([
    "wicked.interactive.draft.completed",
    "wicked.interactive.edit.completed",
    "wicked.interactive.status.posted",
    // EP-I1: crew's interactive-review seam answers review.requested with one
    // review.completed per reviewer (read back from the ledger), so crew owns it too.
    "wicked.interactive.review.completed",
  ]);
  for (const [type, def] of Object.entries(EVENT_TYPES)) {
    assert.equal(def.owners.includes(PRODUCERS.CREW), crewOwned.has(type), `${type} crew ownership`);
  }
  for (const type of crewOwned) assert.ok(canEmit(type, PRODUCERS.CREW), `${type} crew emit`);
  // The existing owners kept their rights — the rows widened, nothing narrowed.
  assert.ok(canEmit("wicked.interactive.draft.completed", PRODUCERS.AGENT));
  assert.ok(canEmit("wicked.interactive.edit.completed", PRODUCERS.AGENT));
  assert.ok(canEmit("wicked.interactive.status.posted", PRODUCERS.AGENT));
  assert.ok(canEmit("wicked.interactive.status.posted", PRODUCERS.SERVICE));
  assert.ok(canEmit("wicked.interactive.review.completed", PRODUCERS.AGENT));
  // ...and the browser still cannot originate a review verdict (EP-I1).
  assert.ok(!canEmit("wicked.interactive.review.completed", PRODUCERS.UI));
  assert.ok(!uiEmittable("wicked.interactive.review.completed"));
});

test("review schemas carry the version under review and crew's findings (EP-I1)", () => {
  const read = (t) => JSON.parse(readFileSync(join(SCHEMA_DIR, `${t}.json`), "utf-8"));
  const req = read("wicked.interactive.review.requested");
  assert.ok(req.required.includes("version"), "review.requested requires version");
  assert.equal(req.properties.version.type, "integer");
  assert.equal(req.properties.version.minimum, 0);
  assert.deepEqual(req.properties.reviewers.items.enum, ["match", "a11y", "copy", "qe"]);
  const done = read("wicked.interactive.review.completed");
  assert.equal(done.properties.version.type, "integer");
  assert.equal(done.properties.findings.type, "array");
  const item = done.properties.findings.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ["sentence", "severity", "wid"]);
  assert.ok(item.required.includes("sentence"));
  // An agent's legacy verdict is free text, so `version`/`findings` stay optional here.
  assert.deepEqual(done.required, ["document_id", "ts"]);
});

test("UI may only originate the conversational/intent events", () => {
  // Hand-maintained whitelist — POST /api/events accepts ONLY uiEmittable types,
  // so this is a security boundary. The set is pinned by hand (not derived from
  // the registry) precisely so a flipped uiEmittable flag on a service/agent
  // event fails here instead of silently widening what the browser may originate.
  const uiYes = ["wicked.interactive.feedback.submitted", "wicked.interactive.chat.posted", "wicked.interactive.question.answered",
    "wicked.interactive.source.attached", "wicked.interactive.source.removed", "wicked.interactive.demo.requested",
    "wicked.interactive.theme.requested", "wicked.interactive.review.requested", "wicked.interactive.status.requested"];
  const uiNo = ["wicked.interactive.edit.completed", "wicked.interactive.draft.completed", "wicked.interactive.version.created",
    "wicked.interactive.feedback.processed", "wicked.interactive.status.posted", "wicked.interactive.doc.created",
    "wicked.interactive.doc.retired",
    "wicked.interactive.source.updated", "wicked.interactive.export.requested", "wicked.interactive.export.generated",
    "wicked.interactive.export.reviewed", "wicked.interactive.error.raised", "wicked.interactive.theme.learned",
    "wicked.interactive.review.completed"];
  for (const t of uiYes) assert.ok(uiEmittable(t), `${t} should be UI-emittable`);
  for (const t of uiNo) assert.ok(!uiEmittable(t), `${t} should NOT be UI-emittable`);
  // Completeness: the two hand-maintained lists must together cover EVERY known
  // type, so a newly added event can't slip past this boundary unclassified.
  assert.deepEqual([...uiYes, ...uiNo].sort(), Object.keys(EVENT_TYPES).sort(),
    "uiYes ∪ uiNo must cover every registered event type");
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
