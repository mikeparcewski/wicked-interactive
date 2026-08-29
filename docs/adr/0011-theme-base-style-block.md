---
id: wicked-interactive-adr-0011
title: "Theme tokens as a per-version base style block"
status: active
date: 2026-05-27
---
# ADR-0011 — Theme tokens as a per-version base style block

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0011)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Theme tokens render into a per-version base `<style>` block using **element-level selectors** so
it is a genuine base layer — a document's own classed/inline styles win. The block is injected
first, is idempotent (a marker attribute makes re-runs replace, not stack), and never touches
`data-wid` anchors (INV-1/INV-2 safe). Token resolution from the in-repo theme library lives in
the service layer; the core stays pure and unit-testable. Slide/section containers get their own
anchor namespace so whole containers are restyleable.

**Tag sites:** `src/core/theme.js:1`, `src/core/instrument.js:30,93`.
