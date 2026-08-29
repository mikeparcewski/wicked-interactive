---
id: wicked-interactive-adr-0007
title: "FIFO mutation serialization"
status: active
date: 2026-05-26
---
# ADR-0007 — FIFO mutation serialization

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0007)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Each document processes **one mutation at a time** through a promise-chain FIFO, so concurrent
regenerations/forks never race on the version manifest. The queue returns the promise of THIS
task (so the command loop can retry/DLQ a failure) while keeping the chain alive after an error.
Command handlers are the ONLY place the service mutates workspace state.

**Tag sites:** `src/service/server.js:94`, `src/service/handlers.js:4`.
