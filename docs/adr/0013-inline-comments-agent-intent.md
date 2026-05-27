# ADR-0013: Inline comments + agent-mediated intent

## Status
Accepted — 2026-05-27 (product-owner direction; revises the user-facing flow of ADR-0003)

## Context
The sidebar feedback panel made users pick a *mode* (write text / give feedback / restyle)
and stage edits in a two-step (Add → UPDATE) flow. Dogfooding showed this is friction: users
just want to point at a thing, say what they want in plain words, and have the tool figure
out what to do. The PO asked for: an **inline comment box** on the block, and **the agent
determining intent** (asking if unsure, via the ADR-0012 channel).

## Options Considered
- **(a) Agent determines intent for every comment — CHOSEN (PO-directed).** Users type one
  plain comment; the supervising agent classifies it (replace text / rework / restyle /
  section change) and applies it, asking when ambiguous.
- (b) Service heuristic classification with agent fallback — rejected for now: regex intent
  guessing is brittle, and "am I sure?" is exactly the judgment only the agent makes well.
  Kept as a possible future fast-path optimization.

## Decision
1. **Inline comment box.** Clicking a block opens a small popover anchored at the block (no
   sidebar). It has a free-text comment, a Send/Cancel, and a compact **block / section**
   scope toggle (preserves ADR-0011). Sending submits **immediately** — one comment is one
   edit is one version (no staging, no UPDATE button).
2. **Agent-mediated intent.** Every comment is recorded as a `structural-change` carrying
   the comment as its instruction. The agent, fulfilling the request (ADR-0010), **determines
   intent** and produces the right edit: a literal text replacement, a reworded block, a
   style/background change, or a section restyle — always preserving every `data-wid`
   (INV-2). If the comment is ambiguous, the agent **asks** (`POST /api/status` state
   `asking`) and waits for the answer (`/api/answer`) before acting.

## Consequences
- Far simpler UX: point, comment, done. No modes, no staging, no sidebar.
- **Trade-off (revises ADR-0003):** determinism-first is no longer user-facing — *every*
  edit is now agent-mediated, so trivial edits also wait on the agent and the agent must be
  running. The engine's deterministic paths remain (the agent's own edits are applied
  through them and the INV-2 gate); they're just no longer a user-selected fast path. A
  service-side heuristic fast-path (option b) can be reintroduced if latency matters.
- The agent's fulfillment contract now explicitly includes **intent classification** and
  **clarification-on-ambiguity**.

## Trade-offs Accepted
Latency + agent-dependence for all edits, in exchange for a point-and-say-it experience and
reliable intent handling. The PO accepted this; revisit with a heuristic fast-path if needed.
