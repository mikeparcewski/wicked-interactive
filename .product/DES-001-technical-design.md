---
name: DES-001-technical-design
title: wicked-interactive — Technical Design
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Technical Design

## Purpose

Load-bearing architecture decisions and the design of each major subsystem. Inline `(ADR-00NN)` tags in the code mark the decision sites; this document is the narrative companion. For the full ADR text see `docs/architecture-decisions.md`.

## Architecture Overview

```
          ┌─────────────────────────────────────────────┐
          │              wicked-bus (SQLite)             │
          │          domain: wicked-interactive          │
          └────────┬──────────────────────┬─────────────┘
                   │ subscribe/emit        │ subscribe/emit
          ┌────────▼──────────┐   ┌───────▼────────────┐
          │  Node.js Service  │   │  Supervising Agent │
          │  (wi-service)     │   │  (wi-agent)        │
          │  Express 5        │   │  wicked-garden     │
          └────────┬──────────┘   └────────────────────┘
                   │ SSE / POST /api/events
          ┌────────▼──────────┐
          │  React/Vite SPA   │
          │  (wi-ui)          │
          └───────────────────┘
```

Three actors, one bus vocabulary, one service bridging bus to browser. The service and agent never call each other directly — they communicate only through bus events.

## Event-Driven Control Plane (ADR-0019)

Before ADR-0019, the system spoke four overlapping dialects: SSE event names, request/response JSON files, agent-facing HTTP endpoints, and fire-and-forget telemetry. ADR-0019 collapsed these onto a single wicked-bus vocabulary.

### Event vocabulary

Defined in `src/service/events.js`. All 22 types follow the naming convention `wicked.interactive.<noun>.<past-verb>` and are grouped into subdomains:

| Subdomain | Event types |
|---|---|
| `docs` | `doc.created` |
| `feedback` | `feedback.submitted`, `feedback.processed`, `edit.completed` |
| `generation` | `draft.completed` |
| `chat` | `chat.posted`, `question.answered` |
| `status` | `status.posted`, `status.requested` |
| `sources` | `source.attached`, `source.updated`, `source.removed` |
| `demo` | `demo.requested` |
| `theme` | `theme.requested`, `theme.learned` |
| `review` | `review.requested`, `review.completed` |
| `versions` | `version.created` |
| `export` | `export.requested`, `export.generated`, `export.reviewed` |
| `error` | `error.raised` |

Document identity never appears in an event type. It rides in `payload.document_id` on every event (D4 of ADR-0019). This keeps the type cardinality bounded.

### Type ownership

Every event type declares which producers may emit it (`owners`) and whether the browser may originate it via `POST /api/events` (`uiEmittable`). The `canEmit(type, producer)` function enforces ownership at every emit site. Consumers drop events whose `producer_id` matches themselves (loop safety).

### Producers

| Producer ID | Actor |
|---|---|
| `wi-service` | Node.js service |
| `wi-agent` | Supervising AI agent |
| `wi-ui` | React/Vite browser SPA |

## SSE Bridge (Service ↔ Browser)

The browser cannot speak the wicked-bus directly (no SQLite access from a browser context). The service bridges:

- **`GET /api/events`** — long-lived SSE connection. The service fans every relevant bus event out to connected browsers as a Server-Sent Event. Multiple browser tabs connect independently; each gets its own fan-out.
- **`POST /api/events`** — accepts browser-originated events. The service validates the event type against the `uiEmittable` whitelist before forwarding it to the bus. Non-whitelisted types are rejected.

The SSE connection is the only persistent connection between the browser and the service. All other browser→service communication is event-based (POST /api/events) or standard REST (`GET /api/docs`, `GET /api/docs/:id/versions`).

## Version Model

Every change to a Document creates a new Version. Files are named `_v{n}.html` (rendered document) and `_v{n}.md` (feedback targeting that version, if any). Nothing is mutated in place.

`versions.json` is the authoritative record of the version chain:
- An ordered list of all versions for a document
- The active pointer (which version the browser is currently showing)
- The fork graph (which versions are branch roots and what their parent version is)

A rewind sets the active pointer to a previous version without deleting any files. A fork creates a new branch root from a chosen version; the branch owns its own sub-sequence of `_v{n}` files.

## Data-Wid Anchoring (ADR-0002)

Every addressable HTML element in a generated document receives a unique `data-wid` attribute. These identifiers are the selectors used in FeedbackItems. They are stable across regeneration cycles because the agent is instructed to preserve them (INV-2, the anchoring invariant). This makes it possible to target a specific element by clicking it in the browser and have that click route to a deterministic edit operation.

The service uses cheerio to inject `data-wid` attributes during initial generation and to apply `content-edit` and `style-edit` operations deterministically without re-invoking the LLM. `structural-change` operations pass a free-text instruction to the agent.

## Feedback Schema (ADR-0002)

Feedback is stored as a Markdown file (`_v{n}.md`) with a YAML frontmatter block and one `## item: <data-wid-selector>` section per FeedbackItem.

**Frontmatter fields:**
- `version` — integer; the target version number
- `base_html` — filename of the HTML being edited (e.g., `_v2.html`)
- `timestamp` — ISO 8601 timestamp
- `author` — optional string

**Item block fields by type:**

| Type | Required | Optional |
|---|---|---|
| `content-edit` | `value` | `before`, `instruction` |
| `style-edit` | `style` (map) and/or `class_add` / `class_remove` | `before` |
| `structural-change` | `instruction` | `before` |
| `remove` | (none beyond selector + type) | `before` |

Parsing and serialization are implemented in `src/core/feedback-schema.js` (`parseFeedback`, `serializeFeedback`, `TYPES`). The schema parser validates all items on parse; invalid types or missing required fields throw immediately.

## Export Gate (ADR-0009 follow-up)

The export flow includes a vision-review step before the user is notified:

1. The service renders the artifact and emits `wicked.interactive.export.generated` with `payload.artifact_path`.
2. The supervising agent receives the event, opens the artifact, and performs a vision review.
3. The agent emits `wicked.interactive.export.reviewed` with its verdict.
4. Only then does the service notify the user and deliver the download.

This prevents delivering a broken export without any quality signal.

## wicked-prezzie Absorption (ADR-0020)

wicked-prezzie was a required sibling plugin. ADR-0020 absorbed its durable assets in-repo:
- The 3 theme JSON files moved to `src/themes/` (resolved by `theme-source.js` without cache probing).
- The HTML→PPTX Python pipeline is vendored under `vendor/` (lazily preflighted; the service verifies toolchain availability before accepting a PPTX export request).
- wicked-prezzie is no longer a dependency.

## Dynamic Port and Lockfile (ADR-0022)

The `--port` argument is a preference, not a guarantee. If the port is in use, the service falls forward to the next free port from 4400 upward. This allows multiple workspaces to serve simultaneously without collision.

A lockfile at `<root>/.wi-serve.json` records `{ port, host, pid, startedAt, version }` for a running bridge. The `serve` command is idempotent: if the lockfile points at a healthy bridge (verified via `GET /api/docs`), it reuses that bridge and exits 0. The lockfile is deleted on clean shutdown.

## wicked-garden Council Adapter

The supervising agent uses wicked-garden's council adapter for:
- Vision-reviewing export artifacts before delivery
- Routing complex structural feedback through a multi-model review when a single-model edit is insufficient

The adapter is invoked by the agent skill (`skills/assist/SKILL.md`), not by the service.
