---
name: REQ-005-dod-criteria
title: wicked-interactive — Definition of Done
status: partially-verified
version: 0.5
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Definition of Done

## Purpose

Structured DoD checklist for wicked-interactive features and for the product as a whole. Three levels gate increasing confidence: Level 1 is the minimum viable check (the thing works locally), Level 2 adds integration and functional correctness, Level 3 is the full acceptance + adversarial gate required before a release is considered shippable.

## Level 1 — Service and Core Mechanics

Basic correctness on the local dev machine.

- [x] `node bin/wicked-interactive.js serve --root <dir> --port <n>` starts without error
  <!-- evidence: `node bin/wicked-interactive.js serve --root /tmp/wi-l1-test --port 19999` → first banner line: "wicked-interactive (multi-doc) serving /tmp/wi-l1-test on http://localhost:19999" (printBanner outputs multiple lines; this is the first); SIGINT (Ctrl-C) → exit 0. bin/wicked-interactive.js:114-115 registers both SIGINT and SIGTERM; either terminates cleanly. (2026-07-21) -->
- [x] `GET /api/docs` returns HTTP 200
  <!-- evidence: test/multidoc.test.js — "GET /api/docs returns an empty list on a fresh root" parses the JSON body successfully (no explicit 200 assertion in that test case, but the cross-machine smoke in ci.yml uses `curl -fsS` which fails non-zero on any non-2xx, confirming HTTP 200 from the packaged install; CI run 29845901879 passed). -->
- [x] `GET /` serves the React frontend (HTTP 200, `Content-Type: text/html`)
  <!-- evidence: `curl -s -I http://localhost:19999/` → HTTP/1.1 200 OK, Content-Type: text/html; charset=utf-8. Verified on live server (same run as L1-1 above). (2026-07-21) -->
- [x] `GET /api/events` opens an SSE stream; the server sends a 15-second keep-alive comment (`: ping …`) to maintain the connection
  <!-- evidence: src/service/server.js:324-330 — Content-Type:text/event-stream + `setInterval` writes `: ping ${Date.now()}` every 15s. Note: the keep-alive is a comment frame (`: ping ...`); test/bridge.test.js discards comment frames (only collects `event:` and `data:` prefixed lines), so the heartbeat has NO direct test coverage. The ping code is implemented correctly; the DoD claim is verified by code inspection, not by test assertion. (H1 from adversarial-review-v0.6.0) -->
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

- [x] CI (`ci.yml`) is green on `main` — all unit tests pass, plugin version is consistent, cross-machine smoke test passes from packed tarball
  <!-- evidence: CI run 29845901879 on main (2026-07-21) — `verify` job: success. Steps: unit tests (208 pass, 0 fail), `npm run check:version` (0.6.0 consistent), cross-machine smoke (npm pack → foreign dir install → npx wicked-interactive serve → GET /api/docs 200, GET / 200). All three steps pass. -->
- [x] wicked-testing acceptance pipeline: a wicked-testing run (separate evaluator from the agent that ran the tests) produces a PASS verdict recorded in `.wicked-testing/evidence/<run-id>/verdict.json`
  <!-- evidence: `.wicked-testing/scenarios/interactive-self-test.md` v1.1 — 4 assertions (A1: npm test exits 0, fail=0; A2: check:version 0.6.0 consistent across all 3 files; A3: 22 events in EVENT_TYPES registry all 4-segment grammar, non_conforming=[]; A4: whitelist enforcement test found at bridge.test.js:184 and passes in full suite). Independent evaluator (acceptance-test-evaluator) issued PASS for all 4 assertions. Two executor deviations noted (regex variant in A3, full suite instead of targeted run in A4) — neither undermines the evidence. Overall verdict PASS written to `.wicked-testing/evidence/interactive-l3-20260721/verdict.json`. executor=claude-code-main-session, reviewer=acceptance-test-evaluator (structural separation confirmed). (2026-07-21) -->
- [x] Adversarial review PASS: at least one council-adversarial review session completed with no unresolved blockers; review record stored in `.product/reviews/`
  <!-- evidence: .product/reviews/adversarial-review-v0.6.0.md (2026-07-21) — verdict PASS. 0 CRITICAL, 0 blocking HIGH. 1 HIGH (H1: SSE keep-alive ping has no test coverage — DoD comment corrected in L1 SSE criterion above), 4 MEDIUM coverage gaps. Security posture sound. -->

- [x] Cross-product review: wicked-bus event vocabulary and data-wid conventions are consistent with any other wicked-* product that shares these contracts
  <!-- evidence: (1) All 22 wicked-interactive bus events (as defined in `src/service/events.js` `EVENT_TYPES`) follow the canonical 4-segment grammar `wicked.<domain>.<noun>.<past-tense-verb>` (verified by extracting keys from the authoritative EVENT_TYPES registry in events.js, 2026-07-21). No naming violations found. (2) data-wid is a wicked-interactive-internal HTML anchoring convention (`format: slide-{slideIndex}-{role}-{ordinal}` per ADR-0001); no other wicked-* product defines, emits, or subscribes to data-wid. (3) No other wicked-* product subscribes to `wicked.interactive.*` events (grep across wicked-garden, wicked-crew, wicked-core — no matches). Event vocabulary is internally consistent and isolated; no cross-product contract coordination required. -->
- [x] `npm run check:version` passes (package.json version matches `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`)
  <!-- evidence: `npm run check:version` → "✓ Plugin version 0.6.0 is consistent across package.json, plugin.json, and marketplace.json" (2026-07-21) -->
- [x] Release notes drafted; changelog entry added
  <!-- evidence: CHANGELOG.md — [0.6.0] section added (2026-07-21) -->
- [ ] Published to npm (`npm publish`) and plugin marketplace (`/plugin marketplace`)
- [ ] The product site (`pages.yml`) updated and live
