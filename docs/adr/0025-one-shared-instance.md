---
id: wicked-interactive-adr-0025
title: "one shared instance by default (amends ADR-0022)"
status: active
date: 2026-06-11
---
# ADR-0025 — one shared instance by default (amends ADR-0022)

ADR-0022 made `serve` dynamic-port + per-root so distinct projects never collide. In practice
every agent session picked its own root (or hit a flaky 800ms reuse check) and spawned *another*
daemon on 4400, 4401, 4402… — confusing, and there was no obvious "the" instance.

**Decision.** Default to ONE shared instance. `serve` with no `--root` uses the canonical
`~/wicked-interactive/docs`, so every session converges on the same root and **reuses** the single
running bridge instead of spawning a new one. Reuse is hardened: while the recorded daemon pid is
alive we retry `/api/health` (1.5s × 3) before concluding it's unusable, so a busy daemon is reused
rather than duplicated. Per-root isolation is preserved as an **opt-in** (`--root <dir>`) for the
rare case of a deliberately separate instance. Pairs with `--restart` (ADR-0022 follow-up): clean
single-command upgrades, and SIGTERM/SIGINT now has a hard shutdown cap so a daemon can't wedge.
