# ADR-0001: Element anchoring via injected `data-wid` IDs

## Status
Accepted — 2026-05-26 (ratifies multi-model council 3/3 consensus)

## Context
Business users select blocks in the React view; an edit must reliably target the
*same* source element across regenerations. Candidate anchors: IDs injected at
generation time, DOM-path/XPath, or content-hash.

## Options Considered
- **(a) Injected `data-wid` semantic IDs — CHOSEN.** Stable, survives content edits
  and minor structural wrappers.
- (b) XPath / DOM-path — rejected: a single wrapper `<div>` added in a later
  generation breaks every existing anchor.
- (c) Content-hash as primary — rejected: the content is the mutation target, so the
  hash is stale after the first successful edit.

## Decision
Inject a unique `data-wid` attribute on every reviewable element at build/generation
time, formatted `{slide}-{role}-{ordinal}` (e.g. `slide-3-heading-1`). Uniqueness is
enforced at generation. A content-hash is retained **only** as a recovery heuristic to
re-attach an ID that a bad regeneration stripped. `data-wid` is the single source of
truth for targeting and change detection.

## Consequences
- The generator must always emit unique, stable `data-wid`s — a generation-contract
  obligation.
- Every edit pathway must preserve them (see INV-1, and the blocking gate in ADR-0003).
- Enables deterministic targeting and `before`-snapshot change detection.

## Trade-offs Accepted
Generator complexity and reliance on disciplined ID preservation — bounded by the
INV-2 assertion gate (ADR-0003).
