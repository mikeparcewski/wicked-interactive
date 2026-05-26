# ADR-0004: wicked-bus event taxonomy and payloads

## Status
Accepted — 2026-05-26 (ratifies council)

## Context
The file watcher, regeneration engine, SSE server, and export step must communicate
without sharing process memory. wicked-bus is the chosen internal event spine
(at-least-once delivery, SQLite-backed, crash-recoverable).

## Options Considered
- (a) Direct in-process function calls — rejected: couples components, no retry or
  crash recovery.
- **(b) wicked-bus events — CHOSEN.**

## Decision
Three canonical event types under domain `presentation`:

| Event type | Subdomain | Payload |
|---|---|---|
| `presentation.feedback.received` | `feedback` | `{document_id, version_target, feedback_file, item_count, ts}` |
| `presentation.html.updated` | `html` | `{document_id, version, html_file, prev_version, ts}` |
| `presentation.export.requested` | `export` | `{document_id, version, format: "html"\|"pdf", ts}` |

Events are fire-and-forget with at-least-once delivery. Consumers MUST be idempotent
keyed on `(document_id, version)`.

## Consequences
- Components are decoupled, independently testable (wicked-testing), and recoverable
  after a crash mid-regeneration (bus persistence).
- Consumers must implement idempotency.
- Adds an event-schema surface to maintain and version.

## Trade-offs Accepted
Eventual-consistency timing vs direct calls — mitigated for the user-visible path by
SSE (ADR-0006), which carries the "ready" signal to the browser.
