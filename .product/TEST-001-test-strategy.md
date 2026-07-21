---
name: TEST-001-test-strategy
title: wicked-interactive — Test Strategy
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Test Strategy

## Purpose

How wicked-interactive is tested, what each layer covers, and what gates must pass before a change is considered done. This document covers unit, integration, end-to-end, and acceptance testing. Manual browser testing is also described.

## Test Layers

### Layer 1 — Unit tests (`test/*.test.js`)

Run with the Node.js built-in test runner (`node --test`). No browser, no live bus required. Tests are self-contained and fast.

```
npm test
```

Key test suites and their scope:

| Suite | Scope |
|---|---|
| `events.test.js` | Event type vocabulary: `isKnownType`, `canEmit`, `uiEmittable`, `subdomainOf`, `ownerOf` — all 22 types |
| `feedback-schema.test.js` | `parseFeedback` and `serializeFeedback` round-trips; error cases (missing frontmatter, invalid type, missing required fields per type) |
| `server.test.js` | Express routes: `/api/docs`, `/api/events` SSE, `POST /api/events` whitelist enforcement |
| `versions.test.js` | Version chain creation, active pointer, rewind, fork graph in `versions.json` |
| `export.test.js` | Export artifact path generation and preflight logic (without browser binaries) |
| `bus-client.test.js` | wicked-bus subscribe/emit integration — isolates bus via `WICKED_BUS_DATA_DIR`; no external bus required |
| `bridge.test.js` | SSE fan-out bridge (bus event → SSE client) |
| `serve-bridge.test.js` | Service startup: port selection, lockfile write/delete, reuse detection |
| `workspace.test.js` | Workspace directory layout, `versions.json` initialization |
| `structural.test.js` | Structural-change instruction routing |
| `regenerate.test.js` | Deterministic regeneration from feedback file |
| `theme.test.js` | Theme resolution from `src/themes/` |
| `pptx.test.js` | PPTX pipeline preflight and invocation |
| `instances.test.js` | Multi-document workspace management |
| `multidoc.test.js` | Multiple concurrent documents in one workspace |
| `preflight.test.js` | Bus and brain liveness checks; Playwright browser binary detection |
| `instrument.test.js` | `data-wid` injection via cheerio (INV-2) |
| `from-garden.test.js` | wicked-garden council adapter integration points |
| `frontend-*.test.js` | Frontend logic (feedbackStore, SSE client, selection, apiPath) — run in Node with jsdom |
| `demo.test.js` | Demo recording request routing |
| `handlers.test.js` | Event handler dispatch table |
| `queue-fork.test.js` | Fork branch creation and queue isolation |
| `theme-grab.test.js` | Theme extraction from existing HTML |
| `generation.test.js` | Draft generation event flow |

### Layer 2 — End-to-end acceptance test (`test/e2e.mjs`)

Requires a built frontend (`frontend/dist/`) and a Chromium binary (Puppeteer). The bus is isolated via `WICKED_BUS_DATA_DIR` — no separately-started wicked-bus required. The test drives a real browser with Puppeteer against the running service.

Run with:

```
npm run acceptance
```

(This builds the frontend first, then runs `e2e.mjs`.)

### Layer 3 — CI smoke test (`.github/workflows/ci.yml`)

The CI workflow performs a cross-machine smoke test that goes beyond the unit tests:

1. Packs the npm tarball (`npm pack`)
2. Installs the tarball into a fresh directory (not the source tree)
3. Starts the service via `npx --no-install wicked-interactive serve ...`
4. Polls `GET /api/docs` and `GET /` to verify the service came up from the packaged install
5. Asserts HTTP 200 on both routes

This catches packaging omissions (files missing from the `files` array in `package.json`) that unit tests cannot.

### Layer 4 — wicked-testing Acceptance Gate

A formal acceptance run using the wicked-testing pipeline. The evaluator agent is separate from the agent that ran the tests (structural separation; no self-grading). Verdict is recorded in `.wicked-testing/evidence/<run-id>/verdict.json`.

A wicked-testing PASS is required before any release (DoD Level 3).

### Layer 5 — Manual Browser Testing

For visual and interaction testing that automated tests cannot cover:

1. Start the service: `node bin/wicked-interactive.js serve --root /tmp/wi-docs --port 4400`
2. Open `http://localhost:4400` in the browser
3. Verify: frontend loads, SSE connection established (visible in browser DevTools → Network → EventStream)
4. Submit a feedback event from the browser; verify it appears in the bus stream (`wicked-bus subscribe --filter '*@wicked-interactive'`)
5. Verify iframe reload on `wicked.interactive.version.created`
6. Test export: request HTML, PDF (if Playwright available), PPTX (if Python toolchain available)

## What Tests Do Not Cover

- Playwright browser download (CI skips with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; tested manually only)
- wicked-garden council adapter quality (not tested by this suite; covered by wicked-garden's own tests)
- Multi-user concurrent editing (not a supported use case in v0.x; no tests exist)
- LLM output quality (the service is model-free; generation quality is the agent's responsibility)

## Test Infrastructure

- **Test runner:** Node.js built-in (`node --test`), available from Node 20+
- **No test framework dependency:** no Jest, no Vitest, no Mocha. Tests use `assert` from the standard library.
- **CI:** GitHub Actions (`ubuntu-latest`, Node 24)
- **wicked-bus in CI:** `bus-client.test.js` and `e2e.mjs` both isolate their own bus DB via `WICKED_BUS_DATA_DIR`; no separately-started bus process is required. `npm test` runs all unit tests including `bus-client.test.js`. The bigger external requirement for acceptance (`e2e.mjs`) is a Chromium binary.
