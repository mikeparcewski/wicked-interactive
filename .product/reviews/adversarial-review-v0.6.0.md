---
name: adversarial-review-v0.6.0
title: wicked-interactive — Adversarial Review v0.6.0
verdict: PASS
date: 2026-07-21
reviewer: council-adversarial
---

# Adversarial Review — wicked-interactive v0.6.0

## Verdict: PASS

The code-level review finds no blocking issues. All L1 DoD claims are either confirmed or plausibly correct with minor caveats (noted below). No CRITICAL or blocking HIGH findings were identified. The product's security posture is sound for a localhost-only service. Several L3 gate items (CI, acceptance pipeline, cross-product review, release notes, publish) remain genuinely open and must be resolved before any release announcement.

---

## CRITICAL findings (block release)

None — no CRITICAL findings.

---

## HIGH findings (should fix before release)

**H1 — DoD claim for SSE keep-alive overstates test evidence (src/service/server.js:330, test/bridge.test.js)**

The DoD states: "test/bridge.test.js opens the SSE stream and receives frames (all bridge tests pass)" as evidence for the 15-second keep-alive ping. This is accurate but misleading. The bridge tests wait for named event frames (`event: wicked.interactive.*\ndata: ...`). The keep-alive writes a comment frame (`: ping ${Date.now()}\n\n`), which the `openBridge()` helper in bridge.test.js silently discards (lines 54–58 filter for `event:` and `data:` prefixes; comment lines starting with `:` are never collected). The 15-second heartbeat has no test coverage whatsoever. The code is correctly implemented at `server.js:330`, but the DoD evidence citation is wrong.

**Impact**: Low runtime risk (the ping code is trivially correct). The concern is that the DoD claim references test evidence that does not exist. If the ping were accidentally removed, no test would catch it.

**Recommendation**: Add a test that asserts comment frames arrive within the heartbeat window, or lower the heartbeat interval to a test-feasible value (e.g. 200 ms with an injectable option) and test it. Alternatively, correct the DoD comment to acknowledge this is untested.

---

## MEDIUM findings (coverage gaps, minor issues)

**M1 — `GET /api/docs` DoD claim lacks explicit HTTP 200 assertion (test/multidoc.test.js:24)**

The DoD marks this criterion checked with the caveat "explicit status assertion not present." Confirmed: the test calls `(await fetch(...)).json()` directly without asserting `res.status === 200`. A non-200 response that still returns a JSON body (e.g. a 207 or a structured error body) would silently pass the test. The DoD correctly acknowledges this gap; no additional action needed beyond the existing note.

**M2 — `isLocalRequest` guard's `ip === ""` case is never tested for the reject path (src/service/server.js:224–229, test/server.test.js:153–172)**

`isLocalRequest` allows access when the computed IP is `"127.0.0.1"`, `"::1"`, `"localhost"`, or `""`. The empty-string case would match any request in which both `req.ip` and `req.socket?.remoteAddress` are absent or falsy. In standard Express v5 without a reverse proxy, this cannot happen in practice; however, the reject path (a request from a genuine remote IP) is untested. The test only exercises the happy path from localhost.

**Recommendation**: Add a test that spoofs a non-local IP and asserts the 403 response from `/api/fs`. Consider tightening the guard to remove the `ip === ""` case or replacing it with a documented explanation.

**M3 — Positive `structural-change` parse not covered in test suite (test/feedback-schema.test.js)**

The DoD correctly notes this gap: "Positive parse of structural-change not yet in test suite." The four tested cases (content-edit, style-edit, remove, structural-change negative) do not include a successful `structural-change` round-trip through `parseFeedback`. The type is exercised end-to-end in bridge.test.js (the structural loop test), but the unit test for `parseFeedback` itself does not have a positive `structural-change` fixture.

**M4 — In-process idempotency set (`processedKeys`) is lost on restart (src/service/server.js:308)**

`processedKeys` is a `new Set()` per `createMultiServer` call. A crash-restart replays the cursor from its last durable position (wicked-bus at-least-once semantics), so commands already processed pre-crash arrive again. The bus-level dedup (WB-002 duplicate-key rejection) provides a second gate, but only for commands emitted with an `idempotency_key`. The comment loop in `bridge.test.js:194` verifies the in-process guard works for an uninterrupted session; a crash-replay scenario is not tested. This is a known limitation of at-least-once delivery and is mitigated if emitters consistently set `idempotency_key`, but the service's command handler does not validate that the key is present.

---

## LOW findings

**L1 — `GET /` frontend serving has no unit test (src/service/server.js:270–271)**

Correctly marked open in the DoD. `express.static(staticDir)` is only mounted if `existsSync(staticDir)` is true. In CI the `frontend/dist` directory may not be present unless `npm run build --prefix frontend` has run. No unit test verifies Content-Type or 200 status for the root route. Acceptable as a known gap; flagged for awareness.

**L2 — Shutdown hard-cap timer has no cleanup on normal exit (bin/wicked-interactive.js:110)**

The 2.5-second hard-cap `setTimeout(() => process.exit(0), 2500).unref?.()` fires process.exit unconditionally. If `svc.stop()` completes quickly (the common path), `process.exit(0)` is called at line 112 anyway, and the timer is orphaned (though `.unref()` prevents it from delaying the process). On a healthy stop this is harmless. On a slow stop it force-kills SSE clients without sending an HTTP close frame. Minor and acceptable for a local service.

**L3 — No bound on `processedKeys` set growth (src/service/server.js:308)**

`processedKeys` accumulates every processed `idempotency_key` for the lifetime of the process. A long-running server with many commands will grow this set indefinitely. For a local single-user service this is unlikely to matter, but it is an unbounded data structure with no eviction policy.

---

## L1 DoD criteria verification

| Criterion | Verdict | Notes |
|---|---|---|
| `serve` command starts without error | — | Requires live service; correctly marked open |
| `GET /api/docs` returns HTTP 200 | PLAUSIBLE | JSON body is parsed successfully in tests; no explicit `assert.equal(res.status, 200)`. DoD comment correctly acknowledges this. |
| `GET /` serves React frontend (200 + text/html) | — | Correctly marked open; `express.static` wired but not unit-tested |
| SSE stream opens; 15-second keep-alive comment sent | PARTIALLY CONFIRMED | Stream opening and event-frame delivery confirmed by bridge tests. The 15-second `: ping` comment frame is NOT verified by any test (see H1). Code at `server.js:330` is correct. |
| `POST /api/events` whitelist: UI-emittable → accepted; non-whitelisted → 403; unknown → 400 | CONFIRMED | `bridge.test.js:184-192` exercises all three cases with correct status codes. `isKnownType` uses `Object.prototype.hasOwnProperty.call` (prototype-safe). |
| `parseFeedback` parses content-edit, style-edit, remove; structural-change negative case | CONFIRMED (with gap) | All four cases tested. Positive structural-change parse absent (M3). |
| `serializeFeedback` round-trips cleanly | CONFIRMED | `feedback-schema.test.js:88` passes. |
| `npm test` passes with no failing tests | CONFIRMED | 208 tests, 0 failures, 0 skipped. Run confirmed on 2026-07-21. |
| Lockfile written on start; deleted on SIGINT/SIGTERM | CONFIRMED | `removeLock(root)` called synchronously at `bin:107` before `await svc.stop()`. `process.on("exit")` at `bin:116` provides belt-and-suspenders. `stopDaemon` unit tests verify SIGTERM/SIGKILL escalation and lock removal. No integration test fires a live signal into a real process, but the logic is simple and the unit coverage is thorough. |

---

## L2 DoD criteria assessment

The following L2 items are genuinely blocked (require live browser or running agent) and cannot be unit-tested without significant harness investment:

- Browser feedback submission end-to-end (requires a real browser session)
- Feedback file written to workspace with correct frontmatter (requires the service loop to run against a real feedback event)
- Agent processes feedback and writes `_v{n+1}.html` (requires a live agent session)
- `wicked.interactive.version.created` emitted; browser iframe reloads (requires running browser + event delivery)
- Version rewind rendering (requires running browser)
- Fork visible in `versions.json` with independent editability (partially covered by `workspace.test.js` for fork mechanics; the UI-visible fork flow requires a browser)
- Source attachment recording and next-generation cycle (bus event is tested; `sources.json` read is tested in bridge.test.js; the generation cycle requires a live agent)
- Export artifact validity: self-contained HTML (covered partially by `server.test.js`; "no external fetches" claim not verified); PDF valid binary; PPTX opens in PowerPoint (all require live rendering)
- Type-ownership whitelist enforcement at the emitter level (verified in `bus-client.test.js:61-73` for `emitEvent` rejection; full cross-service enforcement requires a running multi-service scenario)
- `npm run acceptance` (requires built frontend + browser)

**Items that could be unit-tested but aren't**:
- The ≤ 500 ms delivery timing for wicked-bus events (`bus-client.test.js` verifies the event lands in the SQLite store but does not measure delivery latency to a subscriber).
- The `isLocalRequest` reject path for `/api/fs` (see M2).
- The SSE 15-second keep-alive comment frame (see H1).

---

## Security focus assessment

**Event whitelist** — SOUND. `POST /api/events` applies `isKnownType` (400) then `uiEmittable` (403) checks in the correct order. Prototype-injection safe (`Object.prototype.hasOwnProperty.call`). Tested in `bridge.test.js:184-192`. The bus-client further enforces producer ownership at emit time (`canEmit` in `events.js:80`, enforced in `bus-client.js`), providing a second layer.

**Lockfile cleanup on SIGINT** — SOUND. `removeLock(root)` is called synchronously before `await svc.stop()` in the `shutdown` handler (`bin:104-116`), so the lock is gone even if `svc.stop()` hangs. The 2.5-second hard cap ensures the process exits. `process.on("exit")` provides a final safety net. Unit tests cover SIGTERM-graceful and SIGKILL-forced paths.

**Path traversal — export download** — SOUND. `/api/export/file/:name` applies `!/^[A-Za-z0-9._-]+$/.test(name)` before constructing `filePath`, preventing `..` or `/` in filenames. Tested at `server.test.js:97-102` with `../_v0.html`. `res.sendFile` is called on the validated path.

**Path traversal — recording download** — SOUND. Same slug-charset regex applied at `server.js:149`. Not explicitly tested for the reject path, but the same guard as the export download.

**Path traversal — `/api/fs`** — ACCEPTABLE with caveat. Uses `resolve(...)` to normalize paths; no directory restriction is applied, which is by design for the file picker. The localhost-only guard (`isLocalRequest`) is the primary defense. The `ip === ""` case is a latent weakness (see M2), but not exploitable under normal operation.

**SQL injection** — NOT APPLICABLE. No raw SQL is constructed from request input in the service layer. `bus-client.js` uses `busDb().prepare(...)` with parameterized queries.

**Command injection** — NOT APPLICABLE. `spawn` in `bin/wicked-interactive.js` uses controlled arguments (no user-supplied shell strings). PPTX export via `pptx.js` was not read but export format is validated against an allowlist (`["html", "pdf", "pptx"]`) before routing.

**JSON body size limit** — PRESENT. `express.json({ limit: "5mb" })` applied at both `createServer` and `createMultiServer`. No unbounded-input risk.

**Doc name injection** — SOUND. `DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/` restricts document names to slug-safe characters with no path separators. Used for every filesystem path constructed from a doc name.

---

## Summary

wicked-interactive v0.6.0 is in solid shape for a local-service product at this stage of development. The core mechanics — event vocabulary, SSE bridge, whitelist enforcement, deterministic feedback application, lockfile lifecycle, and path-traversal defenses — are all correctly implemented and covered by a 208-test suite that passes cleanly.

The most significant gap is that the DoD's evidence citation for the 15-second SSE keep-alive ping overstates what the tests actually verify (H1). The keep-alive code is correct but untested. The `isLocalRequest` reject path and positive `structural-change` parse are also untested (M2, M3).

All L3 gate items beyond this code review remain open: CI status is unverifiable from source alone, the wicked-testing acceptance pipeline has not been run, cross-product event vocabulary review is outstanding, release notes are not drafted, and the product has not been published. These must all be resolved before any release announcement.

**What's solid**: event whitelist enforcement, path traversal defenses, lockfile lifecycle, FIFO command serialization, idempotency guard (session-scoped), feedback schema validation, and the structural edit round-trip.

**What's risky**: SSE keep-alive claim in DoD overstated (H1); in-process idempotency does not survive restarts (M4); `ip === ""` edge case in local-only guard (M2).

**Release readiness**: Code-level PASS. Process gate items remain open. No blocker found in the codebase itself.
