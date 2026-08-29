---
id: wicked-interactive-adr-0022
title: "dynamic port, one bridge per root, discovered via a lockfile"
status: active
date: 2026-06-11
---
# ADR-0022 — dynamic port, one bridge per root, discovered via a lockfile

**Status:** accepted 2026-06-11.

**Context.** `serve` hard-coded port 4400. Two sessions (different docs roots, or the same one)
both tried to bind it and the second crashed with `EADDRINUSE`. The agent also had no way to find
an already-running bridge for a root, so it couldn't decide between "reuse" and "start".

**Decision.** The port is **dynamic** and each root owns **one bridge**, recorded in a per-root
lockfile so any session can find it:

- **Port selection.** No `--port` → take the first free port from 4400 up. `--port N` is a
  *preference*: if N is taken, fall forward to a free port (and say so). Distinct roots therefore
  never collide, so any number of sessions can serve at once. (`server.js start()` rejects on
  listen error so the CLI can fall forward instead of dying.)
- **Lockfile.** A live bridge writes `<root>/.wi-serve.json` = `{ port, host, pid, startedAt,
  version }` and deletes it on SIGINT/SIGTERM/exit. It is the answer to "where is the bridge for
  this root" — the agent never has to remember a port.
- **Reuse vs start.** `serve --root R` is idempotent: if `R`'s lockfile points at a **healthy**
  bridge (`GET /api/docs` → 200), it reuses it (prints `reusing live bridge …`, exits 0); if the
  lockfile is stale (process gone / unhealthy) it's cleaned and a fresh bridge starts. The rule
  is "if there's a bridge use it, else start one" — one command does both.

**Why a lockfile and not memory.** State that must survive across independent agent sessions can't
live in one session's context; a file next to the docs is the smallest durable, discoverable
record. It's runtime-only (gitignored) and self-healing — a crash that skips cleanup just leaves a
stale entry the next `serve` detects and replaces.
