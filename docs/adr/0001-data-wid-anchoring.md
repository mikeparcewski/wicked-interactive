---
id: wicked-interactive-adr-0001
title: "Stable data-wid anchors"
status: active
date: 2026-05-26
---
# ADR-0001 — Stable data-wid anchors

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0001)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Every reviewable element in a built document carries a stable `data-wid` anchor, injected by the
model-free instrumenter: format `slide-{slideIndex}-{role}-{ordinal}` (0-based slide index of the
nearest slide container; role derived from the tag; 1-based ordinal per slide+role). Composite
cards opt in via `data-card`. **INV-1:** an element that already carries a `data-wid` keeps it —
anchors are the identity that maps a click in the browser back to an element, keeps versions
navigable across regenerations, and rides inside every fragment the agent edits.

**Tag sites:** `src/core/instrument.js:1` (the injector), `src/service/workspace.js:100`
(anchors ride in agent-edited fragments), `skills/assist/SKILL.md` ("data-wid anchors map a
click back to an element").
