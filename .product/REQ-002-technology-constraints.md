---
name: REQ-002-technology-constraints
title: wicked-interactive — Technology Constraints
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Technology Constraints

## Purpose

This document records the technology stack and the hard constraints that bound implementation decisions. Items marked as constraints are non-negotiable for v0.x; deviations require an ADR.

## Technology Stack

### Service layer

- **Runtime:** Node.js >= 20.0.0 (ES modules; `"type": "module"` throughout).
- **HTTP framework:** Express 5 (`^5.0.0`).
- **Entry point:** `bin/wicked-interactive.js serve --root <dir> --port <n>`. The port is dynamic: if the requested port is taken the service falls forward to the next available port (ADR-0022). A lockfile (`<root>/.wi-serve.json`) records `{ port, host, pid, startedAt, version }` so any session can discover a running bridge without remembering a port.
- **HTML manipulation:** cheerio (`^1.0.0`) — used for `data-wid` injection and structural edits.
- **YAML parsing:** js-yaml v5 (`^5.0.0`) — ESM-only; used in the feedback schema and service internals.

### Frontend

- **Framework:** React/Vite SPA, built to `frontend/dist/` and served as static assets by the Express service.
- **Hot reload:** the browser iframe reloads when `wicked.interactive.version.created` arrives over SSE; the outer shell is a single-page app that does not itself reload.

### Control plane

- **wicked-bus** (`^2.0.0`) — the required event fabric. The service subscribes via the Node.js library (`subscribe()` managed loop); the agent subscribes via the CLI (`wicked-bus subscribe`). The browser cannot speak the bus directly — it communicates through the service's SSE bridge.
- **SSE bridge:** `GET /api/events` fans bus events out to the browser as Server-Sent Events. `POST /api/events` accepts browser-originated events subject to a type-ownership whitelist (`uiEmittable: true` in `src/service/events.js`).
- **Event naming convention:** `wicked.interactive.<noun>.<past-verb>` under domain `wicked-interactive`. Document identity is never encoded in the event type; it rides in `payload.document_id` (ADR-0019 D4).

### Export

- **Playwright** (`^1.60.0`) — headless browser used for PDF rendering and demo video recording. Browser binaries are downloaded separately from the npm package (gated behind a preflight check).
- **PowerPoint (PPTX):** vendored Python-based HTML→PPTX pipeline (lazy-preflighted; the service verifies the toolchain is available before accepting an export request).

### Shared infrastructure

- **wicked-web** — shared site chrome (header, footer, brand assets), consumed as a git dependency.
- **wicked-garden** — the supervising agent uses wicked-garden for council-adapter feedback routing and the vision-review step on exports.

## Constraints

| Constraint | Rationale |
|---|---|
| wicked-bus must be running before the service starts | The bus is the nervous system of the loop (ADR-0021). The service fails fast on startup if the bus is unreachable; there is no degraded mode. |
| Single-host only | wicked-bus v2.x provides no remote transport (Unix-socket push only). All three actors — service, agent, browser — must run on the same host. |
| Durable state lives in workspace files, not on the bus | wicked-bus TTL-sweeps events (24 h delete / 72 h visibility). `versions.json`, `_v{n}.html`, `sources.json`, and `conversation.jsonl` are the authoritative state; the bus is transport only (ADR-0021). |
| Node.js >= 20 required | ES modules with top-level await and the `--test` runner are Node 20+ features. |
| Browser cannot write workspace files directly | The browser emits events via `POST /api/events`; the service is the only actor that materializes events into durable workspace files. |
| Playwright browser binaries are not bundled | The npm package ships without browser binaries. Demo recording and PDF export require a separate browser preflight. |
| The service is model-free | The Node.js service contains no LLM calls. Generation and editing are entirely the agent's responsibility; the service is infrastructure only (ADR-0001 inline tag). |
