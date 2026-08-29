---
id: wicked-interactive-adr-0004
title: "Fire-and-forget wicked-bus telemetry"
status: superseded
date: 2026-05-26
---
# ADR-0004 — Fire-and-forget wicked-bus telemetry

> **Reconstructed 2026-08-29** (AW-12 / arch-R12): this decision originally lived only as
> inline `(ADR-0004)` tags at its load-bearing code sites. This file writes it out under the
> one ADR frontmatter contract (estate ADR-011 §adr-contract); the inline tags remain in the
> code as the canonical markers of where the decision bites.

## Decision (historical)

Beside the original file/SSE control plane, the service emitted a small set of fire-and-forget
wicked-bus telemetry events — announcements only, carrying no control-plane responsibility.

**Superseded by [ADR-0019](0019-one-bus-vocabulary.md)** (2026-06-09): the whole control plane
collapsed onto one wicked-bus v2 vocabulary, so "telemetry beside the protocol" stopped being a
meaningful role — the bus IS the protocol. The original tag sites were removed with the code
they marked; this decision survives only through ADR-0019's supersession note.
