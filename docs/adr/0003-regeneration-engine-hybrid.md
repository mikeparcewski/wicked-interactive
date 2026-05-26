# ADR-0003: Regeneration engine — determinism-first hybrid with ID-preservation gate

## Status
Accepted — 2026-05-26 (ratifies council; encodes INV-2 / INV-3 / INV-4)

## Context
Regeneration must apply targeted edits without collateral change and without losing
`data-wid` IDs. Full-document LLM regeneration risks both collateral mutation and ID
loss — the council's single highest-rated risk.

## Options Considered
- (a) Deterministic-only (council MVP) — rejected by product owner, who wants LLM
  capability in v1.
- (b) Full-document LLM regeneration — rejected: collateral changes guaranteed.
- **(c) Determinism-first hybrid with fragment-scoped LLM — CHOSEN.**

## Decision
- `content-edit` / `style-edit` → **cheerio DOM surgery**, no LLM call.
- `structural-change` → send **only the serialized fragment** of the targeted element
  to the LLM with a strict system prompt ("edit only this element; preserve every
  `data-wid` verbatim"); swap the returned fragment back into the document.
- After any LLM edit, run a **blocking assertion (INV-2):** every `data-wid` present in
  the input fragment must be present and unchanged in the output. On violation, the
  regeneration is **rejected** — not displayed — and the offending item is surfaced to
  the user.
- Versions are **write-once (INV-4):** read `_vN.html`, write `_vN+1.html`; never
  overwrite. Only elements named in `_v{x}.md` may change (INV-3).

## Consequences
- ~80% of business edits are LLM-free, fast (<100ms), deterministic.
- LLM cost incurred only on `structural-change`.
- The ID-preservation assertion is a **required** pipeline step, not optional.
- Failure UX is defined: a rejected edit is reported with the specific item that failed.

## Trade-offs Accepted
Product-owner-accepted risk of shipping LLM edits in v1, bounded by the INV-2 gate and
fragment-scoping.
