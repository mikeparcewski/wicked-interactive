import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gardenCouncilToWiContent } from "../src/artifact/from-garden.js";

// Build a garden data root containing one council transcript and return the root.
function fixture(sessionId = "sess-42", entries) {
  const root = mkdtempSync(join(tmpdir(), "wi-garden-"));
  const tdir = join(root, "projects", "proj-a1b2c3d4", "wicked-jam", "transcripts");
  mkdirSync(tdir, { recursive: true });
  const doc = {
    id: sessionId,
    session_id: sessionId,
    entries: entries || [
      {
        session_id: sessionId, round: 1, persona_name: "Gemini", persona_type: "council",
        entry_type: "council_response",
        raw_text: "RECOMMENDATION: Ship option A behind a flag.\nTOP RISK: schema migration.\nDISQUALIFIER: no backfill plan.",
      },
      {
        session_id: sessionId, round: 1, persona_name: "Codex", persona_type: "council",
        entry_type: "council_response",
        raw_text: "RECOMMENDATION: Option A, staged rollout.\nTOP RISK: dual-write window.\nDISQUALIFIER: none.",
      },
      {
        session_id: sessionId, round: 0, persona_name: "Council", persona_type: "council",
        entry_type: "synthesis",
        raw_text: "## Council Evaluation: Migration strategy\n\n## Verdict\nCouncil recommends Option A (2-0). Primary risk: the hot-table migration.",
      },
    ],
  };
  writeFileSync(join(tdir, `${sessionId}.json`), JSON.stringify(doc));
  return root;
}

const withEnv = (root, fn) => {
  const prev = process.env.WICKED_GARDEN_PATH;
  process.env.WICKED_GARDEN_PATH = root;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.WICKED_GARDEN_PATH; else process.env.WICKED_GARDEN_PATH = prev;
    rmSync(root, { recursive: true, force: true });
  }
};

test("resolves a council transcript by session_id and maps the verdict + per-model cards", async () => {
  const root = fixture();
  await withEnv(root, async () => {
    const r = await gardenCouncilToWiContent("sess-42");
    assert.equal(r.sessionFound, true);
    assert.equal(r.sessionId, "sess-42");
    // title lifted from the synthesis heading (Council Evaluation: prefix stripped)
    assert.equal(r.title, "Migration strategy");
    const types = r.sections.map((s) => s.type);
    assert.ok(types.includes("header"));
    assert.ok(types.includes("recommendation"), "verdict → recommendation section");
    assert.ok(types.includes("card-grid"), "per-model panel");
    const rec = r.sections.find((s) => s.type === "recommendation");
    assert.match(rec.content.text, /Option A/);
    const cards = r.sections.find((s) => s.type === "card-grid").content.cards;
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((c) => c.title).sort(), ["Codex", "Gemini"]);
    // the scaffold split surfaces the model's recommendation in the card body
    assert.match(cards.find((c) => c.title === "Gemini").body, /flag/);
  });
});

test("no id resolves the newest transcript (latest fallback)", async () => {
  const root = fixture("only-one");
  await withEnv(root, async () => {
    const r = await gardenCouncilToWiContent(undefined);
    assert.equal(r.sessionFound, true);
    assert.equal(r.sessionId, "only-one");
  });
});

test("unknown id degrades to a content-pending stub, never throws", async () => {
  const root = fixture();
  await withEnv(root, async () => {
    const r = await gardenCouncilToWiContent("does-not-exist");
    assert.equal(r.sessionFound, false);
    assert.equal(r.sections[0].type, "header");
    assert.ok(r.sections.some((s) => s.type === "callout"), "pending callout present");
    assert.ok(r.sections[0].content.tags.includes("pending"));
  });
});

test("a no-consensus verdict adds a warning callout", async () => {
  const root = fixture("nc-1", [
    {
      session_id: "nc-1", round: 1, persona_name: "Gemini", persona_type: "council",
      entry_type: "council_response", raw_text: "RECOMMENDATION: Option A.\nTOP RISK: x.",
    },
    {
      session_id: "nc-1", round: 0, persona_name: "Council", persona_type: "council",
      entry_type: "synthesis",
      raw_text: "## Council Evaluation: Split decision\n\n## Verdict\nNo consensus — models split between A and B.",
    },
  ]);
  await withEnv(root, async () => {
    const r = await gardenCouncilToWiContent("nc-1");
    const callout = r.sections.find((s) => s.type === "callout");
    assert.ok(callout, "no-consensus → callout");
    assert.match(callout.content.text, /consensus/i);
    assert.ok(r.sections.find((s) => s.type === "header").content.tags.includes("no consensus"));
  });
});
