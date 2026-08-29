---
id: wicked-interactive-adr-0002
title: "Single-writer _v{x}.md feedback files"
status: active
date: 2026-05-26
---
# ADR-0002 — Single-writer _v{x}.md feedback files

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0002)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Feedback lands as a per-version `_v{x}.md` file: YAML frontmatter (`version`, `base_html`,
`timestamp`, optional `author`) plus `## item: <data-wid>` blocks with typed operations —
`content-edit` (`value`), `style-edit` (`style` map and/or `class_add[]`/`class_remove[]`),
`structural-change` (free-text `instruction`, the LLM rung), `remove`. The **service is the
single writer** of feedback files; writes are atomic, so the agent and browser never race a
half-written file.

**Tag sites:** `src/core/feedback-schema.js:1,23` (the schema + per-type fields),
`src/service/workspace.js:9` (single-writer, atomic writes).
