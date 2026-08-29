---
id: wicked-interactive-adr-0010
title: "Model-free service; judgment delegated to the supervising agent"
status: active
date: 2026-05-26
---
# ADR-0010 — Model-free service; judgment delegated to the supervising agent

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0010)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

The service applies deterministic edits, serves versions, materializes state, and bridges the
bus to the browser — it embeds **no model**. Anything needing judgment (structural rewrites,
first drafts, "from my content" generation, demo step authoring, theme vision-reads) is
delegated to the supervising agent. The delegation transport was originally request/response
files; that **file-delegation slice was superseded by [ADR-0019](0019-one-bus-vocabulary.md)**
(events on the bus) — the model-free split itself stands and is the doctrine
`skills/assist/references/edit-routing.md` tabulates.

**Tag sites:** `src/service/handlers.js:110`, `src/service/demo.js:8`,
`src/service/workspace.js:7,11`, `src/service/server.js:721`, `skills/assist/SKILL.md:19`,
`skills/assist/references/edit-routing.md`.
