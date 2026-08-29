---
id: wicked-interactive-adr-0005
title: "The long-running local service"
status: active
date: 2026-05-26
---
# ADR-0005 — The long-running local service

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0005)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

`serve` runs a long-running local express service per docs root. It is **model-free
infrastructure**: it serves versions, accepts the synchronous artifact commands (fork/export),
and bridges the control plane to the browser. It is NOT the intelligence — the supervising agent
is (assist skill). Everything stateful the UI needs must survive a browser reload because the
service, not the page, owns the workspace.

**Tag sites:** `src/service/server.js:1`.
