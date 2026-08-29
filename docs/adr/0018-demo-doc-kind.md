---
id: wicked-interactive-adr-0018
title: "The demo doc kind: agent-authored spec, service-recorded"
status: active
date: 2026-05-30
---
# ADR-0018 — The demo doc kind: agent-authored spec, service-recorded

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0018)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision

A demo points wicked-interactive at a **running app**: the supervising agent explores the URL
and authors a deterministic Playwright spec (`demo.spec.mjs`); the model-free service executes
that spec, owns the browser launch/video capture/tracing/artifact paths, and lands the recording
plus an anchored storyboard as a normal version — so the same feedback → regenerate → hot-reload
loop applies (the agent re-authors the spec, the service re-records; deterministic replay). The
split mirrors ADR-0003 (hybrid) and ADR-0010 (model-free delegation). Playwright is an npm
dependency + browser binaries, not a plugin sibling; the install gate (ADR-0016) blocks demo
creation until it is present.

**Tag sites:** `src/service/demo.js:1`, `src/service/server.js:701`,
`src/service/preflight.js:82`, `bin/ensure-siblings.mjs:18`, `skills/assist/SKILL.md:447`.
