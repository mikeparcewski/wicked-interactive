# ADR-0002: Feedback file schema (`_v{x}.md`) and authorship

## Status
Accepted — 2026-05-26 (schema ratifies council; authorship is a product-owner selection)

## Context
Clicking UPDATE produces a `_v{x}.md` feedback file. The monitor must parse it
deterministically, and non-technical users may inspect it. Two questions: the file
shape, and who writes it.

## Options Considered
**Schema:**
- **Markdown + YAML frontmatter + per-item sections — CHOSEN.** Human-readable and
  machine-parseable; no raw JSON in item bodies.
- Pure prose — rejected: not deterministically actionable.
- Pure JSON — rejected: hostile to non-technical inspection.

**Authorship:**
- **(a) Service is the single writer — CHOSEN.**
- (b) Client writes directly (File System Access API / local bridge) — rejected:
  browser FS-permission friction, no central schema validation, weaker atomicity.

## Decision
`_v{x}.md` = YAML frontmatter (`version`, `base_html`, `timestamp`, optional `author`)
+ one markdown section per feedback item with: `selector` (a `data-wid` value), `type`
(`content-edit` | `style-edit` | `structural-change`), `before` (original content
snapshot), and an optional human-readable `instruction`. The `type` enum is **locked**
to those three values and gates the engine path (deterministic vs LLM — ADR-0003).

**Per-type operation payload (build-phase refinement, 2026-05-26).** For the
deterministic paths to be applied without an LLM, the item carries a *structured*
operation, not prose:
- `content-edit` → `value`: the new inner HTML/text for the element (captured by the UI,
  e.g. inline edit).
- `style-edit` → `style` (CSS prop→value map) and/or `class_add` / `class_remove`.
- `structural-change` → `instruction` (free text) only; interpreted by the
  fragment-scoped LLM (ADR-0003).

Free-text prose that has no structured `value`/`style` is, by definition, a
`structural-change`. This is what keeps content/style edits deterministic.

Authorship: the **local service is the single writer.** React POSTs feedback JSON to a
service endpoint; the service validates against the schema and writes the file
atomically (temp file + rename). Clients never write the file directly.

## Consequences
- One authoritative writer; centralized schema validation; atomic writes prevent the
  monitor from reading a half-written file.
- Requires a service POST endpoint.
- The `type` enum is a stable contract other components depend on; changing it is a
  breaking change.

## Trade-offs Accepted
A local network round-trip per UPDATE (negligible) in exchange for single-writer
integrity.
