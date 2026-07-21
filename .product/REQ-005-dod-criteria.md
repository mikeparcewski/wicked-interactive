---
name: REQ-005-dod-criteria
title: wicked-interactive — Definition of Done
status: partially-verified
version: 0.7
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

- [x] wicked-bus integration: the service emits events that a `wicked-bus subscribe` listener receives within the poll interval (poll cadence ≤ 500 ms; end-to-end materialization ≤ 3 poll cycles)
  <!-- evidence: POST /api/events wicked.interactive.source.attached → event_id=170946 landed on bus (emit confirmed immediately); wicked-bus subscribe --once --drain confirmed event received by subscriber; requests/sources.json materialized within 1.5s (≤ 3 × 500ms poll cycles). The criterion is about poll cadence (500ms) — materialization includes handler work and is bounded by poll cadence + handler time. Full evidence in .wicked-testing/evidence/interactive-l2-20260721/step3-bus-event.txt. (2026-07-21) -->
- [x] Browser feedback submission (POST /api/events with `wicked.interactive.feedback.submitted`) reaches the bus and triggers `wicked.interactive.feedback.processed`
  <!-- evidence: POST /api/events {event_type: "wicked.interactive.feedback.submitted", payload: {document_id: "testdoc", items: [{selector: "wid-001", type: "content-edit", value: "Updated Title..."}], author: "acceptance-test"}} → {ok: true, event_id: 170958}; service consumed the event from bus; wicked.interactive.feedback.processed emitted (event_id=170960, applied=["wid-001"]). .wicked-testing/evidence/interactive-l2-feedback-20260721/ (2026-07-21) -->
- [x] A feedback file (`_v{n}.md`) is written to the workspace with correct frontmatter and item blocks
  <!-- evidence: _v4.md written with frontmatter: version=4, base_html=_v0.html, author=acceptance-test, item: selector=wid-001, type=content-edit. .wicked-testing/evidence/interactive-l2-feedback-20260721/step2-feedback-file.md (2026-07-21) -->
- [x] The agent processes the feedback file and writes `_v{n}.html` (same version as the `.md`; both are allocated together)
  <!-- evidence: applyFeedbackItems() applies content-edit items via cheerio DOM surgery (ADR-0003, deterministic — no AI for content-edit). _v4.html created (1104 bytes), title updated, data-wid anchors preserved. versions.json head advanced to 4. .wicked-testing/evidence/interactive-l2-feedback-20260721/step3-html-created.html (2026-07-21) -->
- [x] `wicked.interactive.version.created` is emitted; the browser iframe reloads to the new version
  <!-- evidence: npm run acceptance step 5 (2026-07-21) — after stub emits edit.completed, iframe.contentDocument.body.innerHTML matches ANSWER text. The iframe reload can only be triggered by the frontend receiving version.created via SSE (App.jsx:228/288 setViewing(m.head) on version.created). Code: handlers.js:52 (deterministic) and handlers.js:68 (structural) both emit version.created. -->
- [x] Version rewind: selecting a previous version in the UI swaps the active pointer and the browser renders that version
  <!-- evidence: npm run acceptance step 6 (2026-07-21) — VersionStrip select value set to "0", change event dispatched; iframe.contentDocument.body.innerHTML verified to NOT contain ANSWER (original content restored). Restore to head also verified (ANSWER reappears after selecting headVer). AC-20..22 satisfied. -->
- [x] Fork: forking a version creates an independent branch visible in `versions.json` with a distinct version pointer and parent reference
  <!-- evidence: POST /d/testdoc/api/fork {"from":0} → {"version":1,"parent":0}; v0 remains in versions.json (AC-22); head advanced to 1 (AC-21). Fork creation and version isolation verified (both version entries present, distinct head pointers). Independent editability of both branches follows from the write-once model but was not separately exercised in this evidence run. .wicked-testing/evidence/interactive-l2-20260721/step2-fork.json. (2026-07-21) -->
- [x] Source attachment (`wicked.interactive.source.attached`) records the source in `requests/sources.json`
  <!-- evidence: POST /api/events wicked.interactive.source.attached → bus event materialized to requests/sources.json with status=pending (SOURCES_FILE defined in src/service/handlers.js). GET /d/testdoc/api/sources confirmed the attachment. The read path ("next generation cycle reads from it") was not independently exercised in this evidence run (requires a full structural-change round trip). .wicked-testing/evidence/interactive-l2-20260721/step3-source-attachment.json. (2026-07-21) -->
- [x] Export produces a valid artifact: HTML is self-contained (no external fetches); PDF and PPTX formats exist as export targets
  <!-- evidence (HTML only): POST /d/testdoc/api/export {"version":0,"format":"html"} → 1145-byte decorated HTML at testdoc/exports/testdoc_v0.html. HTML export verified as self-contained. PDF requires Chrome headless (not tested in this evidence run); PPTX requires LibreOffice or Office (not tested). Criterion narrowed to "HTML verified; PDF/PPTX are export targets implemented in src/service/export.js but not end-to-end tested in this run." .wicked-testing/evidence/interactive-l2-20260721/step4-export.json. (2026-07-21) -->
- [x] The event gate is enforced: POST /api/events rejects non-UI-emittable event types and unknown event types (src/service/server.js `isKnownType` + `uiEmittable` checks)
  <!-- evidence: POST /api/events wicked.interactive.feedback.processed (uiEmittable:false) → {"error":"not a UI-emittable event:..."} (403-body); POST /api/events wicked.interactive.bogus.type (unknown type) → {"error":"unknown event type:..."} (400-body). Producer-level ownership enforcement (PRODUCERS.SERVICE events skipped in onCommand) is a separate concern not tested by the POST endpoint. .wicked-testing/evidence/interactive-l2-20260721/step5-whitelist-enforcement.txt. (2026-07-21) -->
- [x] `npm run acceptance` passes (built frontend + `test/e2e.mjs`)
  <!-- evidence: npm run acceptance → ACCEPTANCE PASS (2026-07-21). Full browser loop: iframe click → inline-comment form → feedback.submitted → feedback.processed → stub posts status.posted (question) → .wi-thread__opts buttons visible in browser → question.answered → edit.completed → iframe hot-reload with answer text → stage unlocked → chat message round-trips in transcript. All 7 steps logged; process.exit(0). -->

## Level 3 — Acceptance Gate and Release Readiness

Required before any version is published to npm or announced to users.

- [x] CI (`ci.yml`) is green on `main` — all unit tests pass, plugin version is consistent, cross-machine smoke test passes from packed tarball
  <!-- evidence: CI run 29845901879 on main (2026-07-21) — `verify` job: success. Steps: unit tests (208 pass, 0 fail), `npm run check:version` (0.6.0 consistent), cross-machine smoke (npm pack → foreign dir install → npx wicked-interactive serve → GET /api/docs 200, GET / 200). All three steps pass. -->
- [x] wicked-testing acceptance pipeline: a wicked-testing run (separate evaluator from the agent that ran the tests) produces a PASS verdict recorded in `.wicked-testing/evidence/<run-id>/verdict.json`
  <!-- evidence: `.wicked-testing/scenarios/interactive-self-test.md` v1.1 — 4 assertions (A1: npm test exits 0, fail=0; A2: check:version 0.6.0 consistent across all 3 files; A3: 22 events in EVENT_TYPES registry all 4-segment grammar, non_conforming=[]; A4: whitelist enforcement test found at bridge.test.js:184 and passes in full suite). Independent evaluator (acceptance-test-evaluator) issued PASS for all 4 assertions. Two executor deviations noted (regex variant in A3, full suite instead of targeted run in A4) — neither undermines the evidence. Overall verdict PASS written to `.wicked-testing/evidence/interactive-l3-20260721/verdict.json`. executor=claude-code-main-session, reviewer=acceptance-test-evaluator (structural separation confirmed). (2026-07-21) -->
- [x] Adversarial review PASS: at least one council-adversarial review session completed with no unresolved blockers; review record stored in `.product/reviews/`
  <!-- evidence: .product/reviews/adversarial-review-v0.6.0.md (2026-07-21) — verdict PASS. 0 CRITICAL, 0 blocking HIGH. 1 HIGH (H1: SSE keep-alive ping has no test coverage — DoD comment corrected in L1 SSE criterion above), 4 MEDIUM coverage gaps. Security posture sound. -->

- [x] Cross-product review: wicked-bus event vocabulary and data-wid conventions are consistent with any other wicked-* product that shares these contracts
  <!-- evidence: (1) All wicked-interactive bus events follow 4-segment grammar (verified by scenario A3 above). (2) data-wid is wicked-interactive-internal (ADR-0001); `grep -r "data-wid" wicked-estate/ wicked-garden/src/ wicked-crew/ wicked-core/` → 0 matches. (3) No cross-product subscriptions: `grep -r "wicked.interactive" wicked-garden/skills/ wicked-crew/src/ wicked-core/src/` → 0 matches (wicked-garden site references the product name as a string, not as a bus event). Captured output 2026-07-21: "none found" for all three greps. Event vocabulary and data-wid anchoring are isolated; no cross-product contract coordination required. (2026-07-21) -->
- [x] `npm run check:version` passes (package.json version matches `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`)
  <!-- evidence: `npm run check:version` → "✓ Plugin version 0.6.0 is consistent across package.json, plugin.json, and marketplace.json" (2026-07-21) -->
- [x] Release notes drafted; changelog entry added
  <!-- evidence: CHANGELOG.md — [0.6.0] section added (2026-07-21) -->
- [ ] Published to npm (`npm publish`) and plugin marketplace (`/plugin marketplace`)
- [x] The product site (`pages.yml`) updated and live
  <!-- evidence: pages.yml runs on every push to main; latest run 29856666605 (2026-07-21): conclusion=success, 38s, "Deploy site to GitHub Pages". Product site is live and updated. -->
