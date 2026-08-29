---
id: wicked-interactive-adr-0016
title: "Sibling install gate and the garden integration slices"
status: active
date: 2026-05-27
---
# ADR-0016 — Sibling install gate and the garden integration slices

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0016)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

The editor's sibling tools are preflighted and auto-installed transparently
(`bin/ensure-siblings.mjs`: every command printed before it runs; `--check` /
`WI_NO_AUTOINSTALL=1` opt out), and the UI reads the gate at `GET /api/preflight`. The gate
originally covered prezzie + brain + garden; after [ADR-0020](0020-prezzie-absorbed.md) and
[ADR-0026](0026-brain-retired-estate-grounding.md), **wicked-garden is the one remaining
sibling plugin** (Playwright is an npm dependency, ADR-0018). The garden integration extended
in slices carried under this tag: **Slice C** — agent-produced versions are re-themed
idempotently so they stay on-theme; **Slice D** — multi-discipline requests route to a
wicked-garden crew; **Slice E** — agent-authored content grounds through the estate knowledge
stores (wicked-garden-mem) instead of being plausibly-wrong.

**Tag sites:** `bin/ensure-siblings.mjs:2`, `src/service/server.js:104`,
`src/service/preflight.js`, `src/service/structural.js:65` (C), `src/core/theme.js:2` (C),
`src/service/workspace.js:45` (C), `skills/assist/SKILL.md:417` (E), `:435` (D),
`skills/serve/SKILL.md:37`.
