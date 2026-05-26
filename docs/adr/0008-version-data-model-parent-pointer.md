# ADR-0008: Version data model — parent-pointer manifest

## Status
Accepted — 2026-05-26 (product-owner selection)

## Context
Reset = fork, non-destructive (AC-21). We need a storage model that represents forks,
guarantees nothing is ever lost (AC-22), and carries per-version metadata (AC-23).

## Options Considered
- **(a) Parent-pointer manifest (implicit tree) — CHOSEN.** Simplest model satisfying
  fork + never-lost.
- (b) Explicit DAG with named branches — deferred: richer UX (branch labels,
  thumbnails) but more state to manage in v1.
- (c) Git-backed (forks = branches) — rejected: reintroduces git semantics under a
  business-user product and adds operational weight.

## Decision
Flat, write-once artifacts `_vN.html` + `_vN.md`, plus a `versions.json` manifest. Each
entry: `{version, parent_version, feedback_file, created_at}` with a separate `head`
pointer. A **fork** creates a new version whose `parent_version` points at an older
version (yielding an implicit tree). Version numbers are **monotonic** (`_v0, _v1, …`)
regardless of branch, so filenames stay unique; the tree shape lives entirely in the
parent pointers. No version is ever deleted (INV-4); every version is reachable through
the manifest (AC-22).

## Consequences
- The simplest structure that satisfies fork + never-lost; a version list/tree renders
  directly from the manifest.
- Branch labels/thumbnails are an additive later step (migrate to an explicit DAG if
  needed).
- Version number ≠ linear position: a fork's child may be `_v7` with `parent_version =
  _v3`. UI must read the tree from parent pointers, not from numeric order.

## Trade-offs Accepted
An implicit tree is less expressive than a named-branch DAG — acceptable for v1.
