---
name: REQ-005-dod-criteria
title: wicked-interactive — Definition of Done
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Definition of Done

## Purpose

Structured DoD checklist for wicked-interactive features and for the product as a whole. Three levels gate increasing confidence: Level 1 is the minimum viable check (the thing works locally), Level 2 adds integration and functional correctness, Level 3 is the full acceptance + adversarial gate required before a release is considered shippable.

## Level 1 — Service and Core Mechanics

Basic correctness on the local dev machine.

- [ ] `node bin/wicked-interactive.js serve --root <dir> --port <n>` starts without error
- [ ] `GET /api/docs` returns HTTP 200
- [ ] `GET /` serves the React frontend (HTTP 200, `Content-Type: text/html`)
- [ ] `GET /api/events` opens an SSE stream; the browser receives heartbeat events
- [ ] `POST /api/events` with a `uiEmittable: true` event type is accepted; with a non-whitelisted type it is rejected (403 or appropriate error)
- [ ] `parseFeedback` correctly parses a feedback file with all four item types (`content-edit`, `style-edit`, `structural-change`, `remove`)
- [ ] `serializeFeedback` round-trips cleanly (serialize → parse → serialize produces identical output)
- [ ] `npm test` passes with no failing tests
- [ ] Lockfile (`<root>/.wi-serve.json`) is written on start and deleted on SIGINT/SIGTERM

## Level 2 — Integration and Functional Correctness

The full feedback loop works end-to-end.

- [ ] wicked-bus integration: the service emits events that a `wicked-bus subscribe` listener receives within the poll interval (≤ 500 ms)
- [ ] Browser feedback submission (POST /api/events with `wicked.interactive.feedback.submitted`) reaches the bus and triggers `wicked.interactive.feedback.processed`
- [ ] A feedback file (`_v{n}.md`) is written to the workspace with correct frontmatter and item blocks
- [ ] The agent processes the feedback file and writes `_v{n+1}.html`
- [ ] `wicked.interactive.version.created` is emitted; the browser iframe reloads to the new version
- [ ] Version rewind: selecting a previous version in the UI swaps the active pointer and the browser renders that version
- [ ] Fork: forking a version creates an independent branch visible in `versions.json`; both branches are independently editable
- [ ] Source attachment (`wicked.interactive.source.attached`) records the source in `sources.json`; the next generation cycle reads from it
- [ ] Export produces a valid artifact: HTML is self-contained (no external fetches), PDF is a valid PDF binary, PPTX opens in PowerPoint/LibreOffice
- [ ] The type-ownership whitelist is enforced: the service rejects events from producers not listed in `owners` for that type
- [ ] `npm run acceptance` passes (built frontend + `test/e2e.mjs`)

## Level 3 — Acceptance Gate and Release Readiness

Required before any version is published to npm or announced to users.

- [ ] CI (`ci.yml`) is green on `main` — all unit tests pass, plugin version is consistent, cross-machine smoke test passes from packed tarball
- [ ] wicked-testing acceptance pipeline: a wicked-testing run (separate evaluator from the agent that ran the tests) produces a PASS verdict recorded in `.wicked-testing/evidence/<run-id>/verdict.json`
- [ ] Adversarial review PASS: at least one council-adapter review session completed with no unresolved blockers; review record stored in `.product/reviews/`
- [ ] Cross-product review: wicked-bus event vocabulary and data-wid conventions are consistent with any other wicked-* product that shares these contracts
- [ ] `npm run check:version` passes (package.json version matches `.claude-plugin/plugin.json` and `marketplace.json`)
- [ ] Release notes drafted; changelog entry added
- [ ] Published to npm (`npm publish`) and plugin marketplace (`/plugin marketplace`)
- [ ] The product site (`pages.yml`) updated and live
