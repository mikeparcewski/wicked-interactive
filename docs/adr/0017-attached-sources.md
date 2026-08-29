---
id: wicked-interactive-adr-0017
title: "Attached sources"
status: active
date: 2026-05-30
---
# ADR-0017 — Attached sources

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0017)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Reference sources attach to a document without copying: the local file picker **writes nothing
and reads in place**. The service persists `requests/sources.json` (so `GET /api/sources` is
correct on reload) and the bridge forwards `source.attached`/`source.updated` events to the UI
and agent directly — the events ARE the update. The agent indexes attached sources for grounded
authorship (assist Step 9, via wicked-garden-mem since ADR-0026).

**Tag sites:** `src/service/server.js:257`, `src/service/handlers.js:163`,
`skills/assist/SKILL.md:671`.
