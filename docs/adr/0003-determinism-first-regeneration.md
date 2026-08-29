---
id: wicked-interactive-adr-0003
title: "Determinism-first hybrid regeneration"
status: active
date: 2026-05-26
---
# ADR-0003 — Determinism-first hybrid regeneration

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0003)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Regeneration is a hybrid with a hard deterministic floor: `content-edit` / `style-edit` /
`remove` are cheerio DOM surgery with **no LLM**; `structural-change` is refused by the
deterministic engine (reason `structural-change-requires-llm`) and delegated up to the
supervising agent as a fragment-scoped edit. Guardrails: **INV-2** — every `data-wid` present in
the input survives (per-item revert on violation plus a global safety net that throws);
**INV-3** — only elements named in the feedback change; **AC-10** — a stale `before` no longer
matching skips the item and flags it instead of guessing.

The ranked deterministic-vs-AI routing this enables is consolidated in
`skills/assist/references/edit-routing.md`.

**Tag sites:** `src/core/regenerate.js:1,95`, `src/service/demo.js:8` (the same split, applied
to demos), `skills/assist/references/edit-routing.md`.
