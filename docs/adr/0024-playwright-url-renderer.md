---
id: wicked-interactive-adr-0024
title: "Playwright URL renderer as the theme-grab default"
status: active
date: 2026-06-11
---
# ADR-0024 — Playwright URL renderer as the theme-grab default

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0024)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

Theme-grab's default URL renderer drives a real headless Chromium via the **plain Playwright
the service already ships** (demo.js drives it the same way): wait for `networkidle` plus a
settle delay so late-hydrating SPA content and webfonts lay out (the fix for half-rendered
grabs), retry transient navigation failures, use a realistic desktop viewport + UA. The raw
`chrome --print-to-pdf` path (`chromeUrlRenderer`) remains exported as a no-browser-deps
fallback. crawlee was evaluated and rejected (a 40–75 MB multi-page crawling framework for one
`page.pdf()` call). Every redirect hop is still SSRF-revalidated and the render pins the final
host's validated IP; `renderer`/`validate`/`fetchImpl` stay injectable for tests.

**Tag sites:** `src/service/theme-grab.js:169,289`.
