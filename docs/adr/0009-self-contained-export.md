---
id: wicked-interactive-adr-0009
title: "Self-contained HTML and PDF export"
status: active
date: 2026-05-26
---
# ADR-0009 — Self-contained HTML and PDF export

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0009)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

A version exports to a **self-contained** interactive HTML — local stylesheets, scripts, images
(data-URI), and `url()` refs inlined, so the file renders and stays interactive straight from
disk — or to PDF via headless Chrome (the same primitive the absorbed prezzie pipeline used,
ADR-0020). Export is browser-triggered; the POST creates the file and returns a `download` URL.
A follow-up gate: the service announces each freshly-rendered artifact with its event.

**Tag sites:** `src/service/export.js:1`, `src/service/server.js:132`,
`src/service/events.js:56`.
