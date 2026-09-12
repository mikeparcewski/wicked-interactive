---
id: wicked-interactive-adr-0028
title: "Recorder preflight + provisioning; recording failures are typed and terminal"
status: active
date: 2026-09-12
---
# ADR-0028 — Recorder preflight + provisioning; recording failures are typed and terminal

## Context

The demo recorder (`src/service/demo.js`, ADR-0018) launches Playwright's bundled Chromium.
Installing the npm package does not provision a browser — `playwright install` does — and the
install chain never ran it. The 2026-09-12 recon (F-RECON-012, BLOCKER) showed the consequence on
a fresh machine: after a 14-minute governed spec run, the first `demo.requested` died on
`browserType.launch: Executable doesn't exist at …/chromium_headless_shell-1243/…`; the command
loop retried the deterministic failure three times in four seconds and dead-lettered it; the doc
thread showed Playwright's ASCII box three times; "Re-record" replayed the same thing into a
second dead letter while its button never left `idle` (F-RECON-014); the UI blamed "the
generation service". `playwright-core` is bundled — there is no importable browser registry — and
`npx playwright install` from an arbitrary cwd fetches a *different* Playwright whose browsers the
bridge would not launch.

## Decision

1. **Preflight without launching, via public surfaces only.** `recorder-preflight.js` asks the
   *bundled* CLI what a recording needs — `playwright install --dry-run <browser>` names every
   component's install location (the headless shell **and** ffmpeg, which `recordVideo` requires)
   — and checks each for Playwright's own `INSTALLATION_COMPLETE` marker. Headless recordings need
   `chromium-headless-shell`; headed ones `chromium`. Snapshots are cached briefly (the UI polls).
2. **Provision on first use with the same bundled CLI** (`node <pkg>/node_modules/playwright/cli.js
   install <browser>`), progress narrated as `status.posted {state:"working"}`, capped by
   `WI_RECORDER_INSTALL_TIMEOUT_MS` (10 min), opt-out `WI_RECORDER_AUTO_INSTALL=0`. An explicit
   `POST /api/demo/browser/install` or `wicked-interactive doctor --install` installs regardless.
3. **Every recorder failure is a typed `RecorderError`, and terminal.** Stable `code`s
   (`recorder_browser_missing`, `recorder_browser_install_failed`, `recorder_launch_failed`,
   `recording_spec_missing`, `recording_spec_invalid`, `recording_step_failed`,
   `recording_failed`, `recording_in_flight`), `source: "recorder"`, `retryable: false` (only
   `recording_in_flight` is `true`), a one-line `remedy`, and details (`missing`,
   `install_command`, `executable_path`, `step`). The same shape rides `status.posted`
   (flattened beside `state:"error"`), `error.raised.context`, and every HTTP refusal.
4. **The materializer acks a recording failure.** `materializeDemo` resolves `{ error }` after
   emitting the typed frames — one honest failure per request. The same spec on the same machine
   replays the same failure, so the bus's retry → dead-letter path is wrong for this command; a
   "Re-record" is one honest attempt.
5. **"Re-record" follows the wire.** Per-doc recording state (`idle` → `preflight` → `installing`
   → `recording` → `recorded` | `failed`) is exposed at `GET /d/:doc/api/demo/status`;
   `POST /api/events` refuses a `demo.requested` while one is in flight (`409 recording_in_flight`)
   and, with auto-install off, refuses a recording whose browser is missing up front
   (`503 recorder_browser_missing`). `GET /api/preflight` carries the snapshot so a skin can warn
   before a spec run is spent. `wicked-interactive doctor` (alias `--check`) is the operator view.

## Consequences

- A fresh install records on the first request (one download), or says exactly why it cannot and
  what to run. No recorder failure dead-letters. crew relays `code`/`remedy` to its run status;
  the studio drives the button from `/api/demo/status` and renders the remedy.
- Playwright internals are not imported: the two public contracts relied on are the CLI's
  `--dry-run` output (label + `Install location:` lines) and the install marker. Both are pinned
  by tests against an empty temp browsers path; CI's `recorder-provision` job runs the real path.
- Trade-off: presence is a child-process probe (~0.3 s, cached 5 s), not an in-process lookup.

**Tag sites:** `src/service/recorder-preflight.js`, `src/service/handlers.js` (`materializeDemo`),
`src/service/server.js` (`/api/demo/status`, the `demo.requested` gate, `/api/demo/browser/install`),
`bin/wicked-interactive.js` (`doctor`).
