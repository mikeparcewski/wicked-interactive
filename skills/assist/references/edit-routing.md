# Edit routing — deterministic-vs-AI rungs (one screen)

The deterministic-before-AI doctrine (**ADR-0010** model-free service + **ADR-0003**
determinism-first regeneration) is real but scattered across the service/agent split,
`feedback-schema.js`, `regenerate.js`, and several assist steps. This page consolidates it into
one ranked table so the on-call agent (and any contributor) can see the whole policy at a glance.

**The standing rule: prefer the lowest rung that fully covers the task.** The service handles
everything it can deterministically, the instant the user submits it; only what genuinely needs
judgment climbs to the agent, and only a multi-discipline ask climbs to a crew. There is no second
embedded model — the service is model-free by design (`skills/assist/SKILL.md:19`, ADR-0010);
do not add one.

## The ladder (most-deterministic → most-AI)

| # | Request / edit kind | Handled by | Mechanism (verified location) | Lands as | GATE |
|---|---|---|---|---|---|
| 1 | **Content edit** (replace an element's text/inner HTML), **style edit** (inline style / class add-remove), **remove** an element | **Service** — deterministic, no model, applied the moment the user submits | cheerio DOM surgery, no LLM: `content-edit`/`style-edit` → `src/core/regenerate.js:77-93`; `remove` → `:94-99`. Feedback types enumerated at `src/core/feedback-schema.js:30`. Batch applied now, structural remainder handed off: `src/service/handlers.js:47-61` (`materializeFeedback`) | `wicked.version.created {kind:"deterministic"}` (`handlers.js:52-54`) | **INV-2** `data-wid` survival — per-item revert + global throw (`regenerate.js:7-8`, `:82-86`, `Inv2Error` `:16-22`); **AC-10** stale-target skip (`:71-75`) |
| 2 | **Targeted fragment rewrite** — a single block needs new prose/structure ("make this card punchier") | **Agent** — judgment; service refuses this rung deterministically | `structural-change` is **rejected by the deterministic engine** (`regenerate.js:100-102`, reason `structural-change-requires-llm`) and partitioned to the agent by `splitItems()` (`src/service/structural.js:18-23`). Agent edits the fragment and emits results; service applies via INV-2 gate (`handlers.js:64-71` `materializeEdit` → `structural.js applyStructuralResults`). Agent procedure: SKILL.md Step 3 (esp. 3c, the self-check before `wicked.edit.completed`) and the change branch of Step 4 | `wicked.edit.completed` → `wicked.version.created {kind:"structural"}` (`handlers.js:67-70`) | **INV-2** re-checked on the agent's fragment in the apply path (`structural.js` header `:3-5`; LLM-path INV-2 note `regenerate.js:115`); agent self-verifies anchors + balanced tags before emit (SKILL.md Step 3c) |
| 3 | **Whole-document change / first draft** — generate from a brief, "add a pricing slide", "make the whole thing premium", first real draft of a blank doc | **Agent** — full authorship, grounded in wicked-brain, worked through the craft references | Agent builds complete markup leaning on `references/` (outline → story-arc → design-principles → html-craft) and self-checks `references/quality-checklist.md`, then emits the draft. Service instruments fresh anchors + themes + lands it (`src/service/generation.js`). Agent procedure: SKILL.md Step 5 (wizard/source draft) and the whole-document branch of Step 4 | `wicked.draft.completed {html\|html_path}` → new version (SKILL.md Step 5, `:337-344`) | **quality-checklist.md** FAIL/WARN/INFO self-check (`references/quality-checklist.md`); grounding rule — *every number grounded in the source or wicked-brain, never invented* (SKILL.md Step 6) |
| 4 | **Multi-discipline** — needs design + copy + structure reasoned about together ("turn this into an investor-ready deck and tighten the narrative") | **Agent → wicked-garden crew** (plan→build→review), with the agent as the single writer back into the loop | Agent dispatches a crew via the Task tool with the head HTML + goal, then lands the crew's output itself (preserving every `data-wid`). Agent procedure: SKILL.md Step 7 | `wicked.edit.completed` (targeted) or `wicked.draft.completed` (whole-doc), same as rungs 2-3 | INV-2 on the landed fragment/draft (agent satisfies the gate; the crew only reasons) — SKILL.md Step 7 |

### Adjacent: review is its own, non-routing rung

A **review pass** (`match` / `a11y` / `copy` / `qe`) is agent judgment but produces **no new
version** unless the user then asks to apply a fix — so it sits outside the edit ladder. The UI
emits `wicked.review.requested`; the service does **not** materialize it (not a command type, ADR-0023);
the agent runs the pass and posts verdicts (`wicked.review.completed` / `wicked.chat.posted
{role:"review"}`). Procedure: SKILL.md Step 8.6. Theme-from-URL/PDF is the same split — deterministic
grab in the service, vision read in the agent (Step 8.5, ADR-0010/ADR-0020).

## Why this split (the two ADRs)

- **ADR-0010 — model-free service.** The service applies deterministic edits, serves versions,
  materializes state, and bridges the bus to the browser. Anything needing judgment is the agent's.
  Inline tags mark the load-bearing sites: `handlers.js:110`, `demo.js:8`, `server.js:466`,
  `workspace.js:7,11`, `theme-grab.js:2`. (Note: `generation.js` and `structural.js` are model-free
  service code but carry no inline ADR-0010 tag — their split is documented here and in their file
  headers instead.)
- **ADR-0003 — determinism-first hybrid regeneration.** `regenerate.js` is the engine that does
  rungs 1 deterministically and *refuses* rung 2, forcing it up to the agent. The two ADRs together
  are the routing policy this table tabulates.

> Docs-only. This table changes no runtime behavior — it names, in rank order, a policy the code
> already enforces.
