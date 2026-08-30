---
id: wicked-interactive-adr-0021
title: "brain + bus are required; the bus is transport, never store"
status: active
date: 2026-06-09
---
# ADR-0021 — brain + bus are required; the bus is transport, never store

**Status:** accepted 2026-06-09. **The brain half is superseded by ADR-0026** (wicked-brain <!-- historical -->
retired into wicked-estate); the bus half stands unchanged.

**Context.** wicked-bus's integration guide tells consumers to treat the bus as *always
optional* (graceful degradation). But here the bus **is** the loop's nervous system, and the
brain **is** how authored content stays grounded. An optional nervous system is a contradiction.

**Decision.** Both are required, with a **fail-fast preflight**: `wicked-bus` is a static
dependency and the db is initialized at serve time; the brain check is upgraded from
"~/.wicked-brain exists" to **server liveness** with an auto-start hint. We still keep the bus's
*mechanical* guidance — idempotent handlers, explicit acks, ≥ 250 ms polls — because those are
correctness, not optionality.

*(Historical note, 2026-08-12: everything this section says about the brain — the requirement
and its preflight check — no longer applies; wicked-brain was retired and grounding moved to <!-- historical -->
wicked-estate via wicked-garden, ADR-0026. Only the bus half of this ADR remains in force.)*

**The bus is transport, not storage.** wicked-bus TTL-sweeps (24 h delete / 72 h visibility), so
durable state **always** lives in workspace files the service materializes from events. An agent
offline past the TTL recovers via `wicked-bus replay` + reconcile-from-files (versions.json /
sources.json remain authoritative). Nothing the user can lose lives only on the bus.
