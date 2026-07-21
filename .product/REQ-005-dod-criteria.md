---
name: REQ-005-dod-criteria
title: wicked-interactive — Definition of Done
status: partially-verified
version: 0.2
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
  <!-- requires live service; not verified statically -->
- [x] `GET /api/docs` returns HTTP 200
  <!-- evidence: test/multidoc.test.js — "GET /api/docs returns an empty list on a fresh root" parses the JSON body successfully, implying HTTP 200 (explicit status assertion not present; 208/208 tests green, 2026-07-21) -->
- [ ] `GET /` serves the React frontend (HTTP 200, `Content-Type: text/html`)
  <!-- src/service/server.js:271 wires express.static(staticDir) and frontend/dist/index.html exists; no unit test asserts the 200+Content-Type end-to-end — mark open -->
- [x] `GET /api/events` opens an SSE stream; the server sends a 15-second keep-alive comment (`: ping …`) to maintain the connection
  <!-- evidence: src/service/server.js:324-330 — Content-Type:text/event-stream + `setInterval` writes `: ping ${Date.now()}` every 15s; test/bridge.test.js opens the SSE stream and receives frames (all bridge tests pass). Note: the keep-alive is a comment frame, not an SSE `event:` frame. -->
- [x] `POST /api/events` with a `uiEmittable: true` event type is accepted; with a non-whitelisted type it is rejected (403 or appropriate error)
  <!-- evidence: test/bridge.test.js:184 — "POST /api/events enforces the UI whitelist + known doc"; non-UI type → 403, unknown type → 400 (passes) -->
- [x] `parseFeedback` correctly parses a feedback file with `content-edit`, `style-edit`, and `remove` item types; `structural-change` negative case (missing `instruction`) is tested
  <!-- evidence: test/feedback-schema.test.js — "parses frontmatter and items" (content-edit), "parses structured style + class fields" (style-edit), "accepts a remove item" (remove), "rejects structural-change missing instruction" (negative). Positive parse of structural-change not yet in test suite. -->
- [x] `serializeFeedback` round-trips cleanly (serialize → parse → serialize produces identical output)
  <!-- evidence: test/feedback-schema.test.js:88 — "round-trips through serialize -> parse" (passes) -->
- [x] `npm test` passes with no failing tests
  <!-- evidence: 208 tests, 0 failures, 0 skipped — run 2026-07-21 on commit ddff809 -->
- [x] Lockfile (`<root>/.wi-serve.json`) is written on start and deleted on SIGINT/SIGTERM
  <!-- evidence: src/service/serve-bridge.mjs:12 — LOCK_NAME=".wi-serve.json"; removeLock calls unlinkSync; bin/wicked-interactive.js:114-115 registers SIGINT/SIGTERM → shutdown; test/serve-bridge.test.js — "lock roundtrip: write → read → remove (ADR-0022)" passes -->

## Level 2 — Integration and Functional Correctness

The full feedback loop works end-to-end.

- [ ] wicked-bus integration: the service emits events that a `wicked-bus subscribe` listener receives within the poll interval (≤ 500 ms)
  <!-- partial: test/bus-client.test.js verifies emitEvent lands a well-formed envelope in the embedded SQLite bus store and threads correlation_id; does NOT verify a real wicked-bus subscribe listener receives the event within ≤500ms — real-bus timing requires a live integration test -->
- [ ] Browser feedback submission (POST /api/events with `wicked.interactive.feedback.submitted`) reaches the bus and triggers `wicked.interactive.feedback.processed`
  <!-- requires running browser; not verified statically -->
- [ ] A feedback file (`_v{n}.md`) is written to the workspace with correct frontmatter and item blocks
  <!-- requires running service loop; not verified statically -->
- [ ] The agent processes the feedback file and writes `_v{n+1}.html`
  <!-- requires live agent; not verified statically -->
- [ ] `wicked.interactive.version.created` is emitted; the browser iframe reloads to the new version
  <!-- requires running browser + agent; not verified statically -->
- [ ] Version rewind: selecting a previous version in the UI swaps the active pointer and the browser renders that version
  <!-- requires running browser; not verified statically -->
- [ ] Fork: forking a version creates an independent branch visible in `versions.json`; both branches are independently editable
  <!-- requires running service; not verified statically -->
- [ ] Source attachment (`wicked.interactive.source.attached`) records the source in `sources.json`; the next generation cycle reads from it
  <!-- requires running service; not verified statically -->
- [ ] Export produces a valid artifact: HTML is self-contained (no external fetches), PDF is a valid PDF binary, PPTX opens in PowerPoint/LibreOffice
  <!-- requires running service; not verified statically -->
- [ ] The type-ownership whitelist is enforced: the service rejects events from producers not listed in `owners` for that type
  <!-- requires running service; not verified statically -->
- [ ] `npm run acceptance` passes (built frontend + `test/e2e.mjs`)
  <!-- requires running browser + built frontend; skipped per DoD verification scope -->

## Level 3 — Acceptance Gate and Release Readiness

Required before any version is published to npm or announced to users.

- [ ] CI (`ci.yml`) is green on `main` — all unit tests pass, plugin version is consistent, cross-machine smoke test passes from packed tarball
- [ ] wicked-testing acceptance pipeline: a wicked-testing run (separate evaluator from the agent that ran the tests) produces a PASS verdict recorded in `.wicked-testing/evidence/<run-id>/verdict.json`
- [ ] Adversarial review PASS: at least one council-adapter review session completed with no unresolved blockers; review record stored in `.product/reviews/`
- [ ] Cross-product review: wicked-bus event vocabulary and data-wid conventions are consistent with any other wicked-* product that shares these contracts
- [ ] `npm run check:version` passes (package.json version matches `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`)
- [ ] Release notes drafted; changelog entry added
- [ ] Published to npm (`npm publish`) and plugin marketplace (`/plugin marketplace`)
- [ ] The product site (`pages.yml`) updated and live
