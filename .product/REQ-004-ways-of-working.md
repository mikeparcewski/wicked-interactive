---
name: REQ-004-ways-of-working
title: wicked-interactive — Ways of Working
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Ways of Working

## Purpose

Dev-time conventions for working on this repo. Runtime behavior (how the supervising agent starts the service and drives the in-browser loop) is defined in `skills/serve/SKILL.md` and `skills/assist/SKILL.md`. This document covers only the development workflow.

## Prerequisites

- Node.js >= 20.0.0
- wicked-bus running (required — the service fails fast if the bus is unreachable)
- wicked-brain server running (required for the agent loop; auto-start hint is shown on failure)
- Playwright browsers installed separately if testing PDF/video export

## Starting the service

```
node bin/wicked-interactive.js serve --root /tmp/wi-docs --port 4400
```

Run this in the background. Docs persist under `--root`; restarting is non-destructive. The service opens the bus connection fail-fast on start (ADR-0021). If the port is taken it falls forward to the next available port (ADR-0022) and logs the actual port it bound.

**After editing `src/service/**` or rebuilding `frontend/dist/`**, restart the process — the running server serves the old backend and old static bundle until restarted. Verify changes with `curl http://127.0.0.1:<port>/api/docs`.

## Rebuilding the frontend

The frontend is a React/Vite SPA. Built output lands in `frontend/dist/` and is served statically by the Express service.

```
npm run build --prefix frontend
```

After a rebuild, restart the service to serve the new bundle.

## Watching bus events

Tail every event the system emits during a dev session:

```
wicked-bus subscribe --plugin dev --filter '*@wicked-interactive' --cursor-init latest
```

This replaces the old `wi-watch.mjs` tail. It uses a durable cursor so missed events are replayed on reconnect.

## Running tests

Unit and integration tests use the Node.js built-in test runner (`node --test`):

```
npm test
```

This runs all `test/*.test.js` files. Individual suites to be aware of:

| File | What it covers |
|---|---|
| `events.test.js` | Event vocabulary whitelist and ownership rules |
| `feedback-schema.test.js` | parseFeedback / serializeFeedback round-trip |
| `server.test.js` | Express routes and SSE bridge |
| `versions.test.js` | Version chain and fork model |
| `export.test.js` | Export artifact generation |
| `bus-client.test.js` | wicked-bus subscribe/emit integration |
| `e2e.mjs` | End-to-end acceptance (requires built frontend) |

Run the acceptance test (requires `frontend/dist/` to be built):

```
npm run acceptance
```

This builds the frontend, then runs `test/e2e.mjs`.

## Plugin version consistency

Before tagging a release, verify the plugin version is consistent across `package.json` and `.claude-plugin/`:

```
npm run check:version
```

This is also enforced in CI.

## CI (GitHub Actions)

Three workflows in `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push to `main`, every PR | `npm ci` → `npm test` → `npm run check:version` → cross-machine smoke test (pack tarball, install into foreign dir, start service, verify `/api/docs` and `/` respond 200) |
| `release.yml` | Tag push | Full release pipeline including npm publish |
| `pages.yml` | Tag push / manual | Publishes product site |

The CI smoke test deliberately installs from the packed tarball (not the source tree) so it catches packaging omissions.

## Stopping the service

Kill the `serve` process when done so nothing is left bound to the port. The lockfile (`<root>/.wi-serve.json`) is deleted on clean exit (SIGINT/SIGTERM). Leave the shared wicked-bus and wicked-brain servers running.

## Branch and PR protocol

Follow the wicked-* ecosystem PR merge protocol: open a branch, open the PR, wait 6–8 minutes for automated reviewers (Gemini, Copilot) and CI, address valid findings, then merge once CI is green and comments are resolved.
