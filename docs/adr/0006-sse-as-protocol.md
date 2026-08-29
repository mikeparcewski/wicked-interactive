---
id: wicked-interactive-adr-0006
title: "SSE as the UI protocol"
status: superseded
date: 2026-05-26
---
# ADR-0006 — SSE as the UI protocol

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0006)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision (historical)

Server-sent events (`GET /api/events`) were the UI↔service protocol: SSE event names WERE the
vocabulary the browser acted on.

**Superseded by [ADR-0019](0019-one-bus-vocabulary.md)** (2026-06-09): the control plane speaks
one wicked-bus vocabulary; SSE survives only as a dumb bus→browser pipe (browsers can't read
SQLite). The original tag sites were removed with the code they marked; this decision survives
only through ADR-0019's supersession note.
