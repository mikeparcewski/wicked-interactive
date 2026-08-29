---
id: wicked-interactive-adr-0015
title: "Multi-document mode"
status: active
date: 2026-05-27
---
# ADR-0015 — Multi-document mode

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0015)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

One express server hosts many workspaces under a docs root, each mounted at `/d/:doc/`
(slug-safe names, no path separators); new docs mount live. The server owns the single
wicked-bus connection for all of them — the SSE bridge down, the whitelisted UI-emit bridge up,
and the command loop that materializes events (ADR-0019).

**Tag sites:** `src/service/server.js:346`, `bin/wicked-interactive.js:6`.
