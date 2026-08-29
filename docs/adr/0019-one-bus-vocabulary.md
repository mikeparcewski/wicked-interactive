---
id: wicked-interactive-adr-0019
title: "One bus vocabulary for the whole control plane"
status: active
date: 2026-06-09
supersedes: [wicked-interactive-adr-0004, wicked-interactive-adr-0006]
---
# ADR-0019 — One bus vocabulary for the whole control plane

**Status:** accepted 2026-06-09 (v0.5.0). Supersedes the *transport* role of ADR-0004
(fire-and-forget telemetry) and ADR-0006 (SSE-as-protocol), and the file-delegation slice of
ADR-0010.

**Context.** The UI↔service↔agent loop spoke four overlapping dialects: SSE event names,
request/response JSON files (`_v{n}.request/response.json`, `_gen.*`, `_demo.*`), agent-facing
HTTP endpoints (`/api/status|message|answer|sources/status|demo/record`), and three
fire-and-forget bus events. Four formats meant four places to change for any new interaction,
plus a bespoke watcher (`wi-watch.mjs`) with its own reconnect/watchdog machinery and a
"reconcile pending on restart" step to paper over missed events.

**Decision.** Collapse the **control plane** onto a single wicked-bus v2 vocabulary (domain
`wicked-interactive`, ~22 `wicked.interactive.<noun>.<past-verb>` types — see `src/service/events.js`).
- The **service** emits/consumes via the wicked-bus Node lib (`subscribe()` managed loop →
  the existing FIFO; `emit()` for facts) and **bridges** to the browser: bus→SSE fan-out down
  (`GET /api/events`), a whitelisted `POST /api/events` up (browsers can't read SQLite, so SSE
  survives only as a dumb pipe).
- The **agent** consumes with `wicked-bus subscribe` (durable cursor → missed events replay,
  killing the silent-watcher and reconcile-pending failure classes) and emits with
  `wicked-bus emit --payload @file`.
- Loop safety: a **type-ownership table** declares who may emit each type; consumers drop
  events whose `producer_id` is themselves; `wicked.interactive.chat.posted` routes on `payload.role`.

**The state plane is untouched.** versions.json, `_v{n}.html`, conversation.jsonl,
sources.json, the INV-2 / data-wid invariants, and the fork model are exactly as before. Only
*how a change is requested and announced* moved to the bus; *what is written and how* did not.

**Consequence.** Deterministic edits go from instant to ≤ poll interval (500 ms) — accepted for
v0.5; the v2 push daemon is the documented sub-10 ms upgrade path. `wi-watch.mjs`, chokidar, the
request/response file protocol, `/api/events/all`, and the agent-facing POST endpoints are
deleted.
