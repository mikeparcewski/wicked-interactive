# ADR-0007: In-flight UPDATE handling — FIFO queue

## Status
Accepted — 2026-05-26 (product-owner selection; refines AC-9)

## Context
A user may submit a new batch of feedback (click UPDATE) while a prior regeneration is
still running. Two strategies: block the UI until done, or queue.

## Options Considered
- (a) Block until done — rejected by product owner: less responsive; the user must wait.
- **(b) FIFO queue — CHOSEN.**

## Decision
The service maintains a **FIFO queue** of feedback batches, serialized via wicked-bus.
A new UPDATE arriving while a regeneration is in flight is **enqueued** (not blocked);
the UI shows queue depth and processing state. Each completed batch produces exactly one
new version.

**Refinement of AC-9:** the UPDATE control still prevents double-submitting the *same*
in-flight batch, but it accepts and queues *new, distinct* batches rather than being
disabled.

## Consequences
- More responsive — the user keeps working while regenerations process.
- Requires queue state, ordering guarantees, and a clear UI of pending versions.
- **Stale-target edge case:** a queued batch whose `before` snapshot has gone stale
  against an intervening version must be re-validated at *processing* time, not submit
  time (AC-10 applies per-batch when dequeued).

## Trade-offs Accepted
Added queue complexity and stale-target handling vs the simplicity of serial blocking.
