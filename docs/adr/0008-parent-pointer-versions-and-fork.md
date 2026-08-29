---
id: wicked-interactive-adr-0008
title: "Parent-pointer version manifest and non-destructive fork"
status: active
date: 2026-05-26
---
# ADR-0008 — Parent-pointer version manifest and non-destructive fork

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0008)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

`versions.json` is a parent-pointer manifest: `head` plus append-only entries
`{version, parent, feedback_file, html_file, created_at}`. Version numbers are monotonic (a
fork's child may be `_v7` with parent `_v3`); **INV-4:** entries are write-once — never mutated
or removed. Fork ("start again from here", AC-21) is non-destructive and enqueued on the FIFO so
it cannot race a bus-driven regeneration.

**Tag sites:** `src/core/versions.js:1`, `src/service/server.js:120`,
`src/service/workspace.js:6`.
