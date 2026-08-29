---
id: wicked-interactive-adr-0014
title: "Per-document conversation transcript"
status: active
date: 2026-05-27
---
# ADR-0014 — Per-document conversation transcript

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0014)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Each document keeps `conversation.jsonl` — an append-only transcript written by the bus bridge
as chat/status events flow (best-effort), read back by `GET /api/conversation`. The transcript
is workspace state, not bus state: it survives the bus's TTL sweep and browser reloads.

**Tag sites:** `src/service/server.js:248`, `src/service/handlers.js:24`.
