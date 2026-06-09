# Architecture Decisions

ADRs in this codebase are primarily **inline `(ADR-00NN)` tags** at the load-bearing site.
This file records the rationale for the decisions that span many files — start here, then
follow the tags into the code.

ADR-0001 … ADR-0018 are the original interactive-builder decisions (data-wid anchoring,
single-writer feedback, deterministic regeneration, SSE transport, version/fork model,
model-free service, multi-doc, install gate, sources, demos). They live as inline tags.

---

## ADR-0019 — One bus vocabulary for the whole control plane

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
`wicked-interactive`, ~14 `wicked.<noun>.<past-verb>` types — see `src/service/events.js`).
- The **service** emits/consumes via the wicked-bus Node lib (`subscribe()` managed loop →
  the existing FIFO; `emit()` for facts) and **bridges** to the browser: bus→SSE fan-out down
  (`GET /api/events`), a whitelisted `POST /api/events` up (browsers can't read SQLite, so SSE
  survives only as a dumb pipe).
- The **agent** consumes with `wicked-bus subscribe` (durable cursor → missed events replay,
  killing the silent-watcher and reconcile-pending failure classes) and emits with
  `wicked-bus emit --payload @file`.
- Loop safety: a **type-ownership table** declares who may emit each type; consumers drop
  events whose `producer_id` is themselves; `wicked.chat.posted` routes on `payload.role`.

**The state plane is untouched.** versions.json, `_v{n}.html`, conversation.jsonl,
sources.json, the INV-2 / data-wid invariants, and the fork model are exactly as before. Only
*how a change is requested and announced* moved to the bus; *what is written and how* did not.

**Consequence.** Deterministic edits go from instant to ≤ poll interval (500 ms) — accepted for
v0.5; the v2 push daemon is the documented sub-10 ms upgrade path. `wi-watch.mjs`, chokidar, the
request/response file protocol, `/api/events/all`, and the agent-facing POST endpoints are
deleted.

## ADR-0020 — wicked-prezzie absorbed, not orchestrated

**Status:** accepted 2026-06-09.

**Context.** wicked-prezzie was a *required sibling plugin*: themes were read off its plugin
cache and the agent "drove its skills." Of its 40 skills / 25 Python modules, most are
superseded by the browser loop (collaborate/feedback/start), wicked-brain (learn/search/index),
or wicked-garden crews (workflow/personas).

**Decision.** Absorb the durable assets in-repo: the 3 theme JSONs move to `src/themes/`
(`theme-source.js` resolves there, no cache probing); the craft methodology becomes curated
references under `skills/assist/references/`. The HTML→PPTX Python pipeline — prezzie's one
genuinely unique asset — is a vendored, lazily-preflighted stretch (own plan). wicked-prezzie is
dropped from preflight/ensure-siblings and the repo is deprecated.

## ADR-0021 — brain + bus are required; the bus is transport, never store

**Status:** accepted 2026-06-09.

**Context.** wicked-bus's integration guide tells consumers to treat the bus as *always
optional* (graceful degradation). But here the bus **is** the loop's nervous system, and the
brain **is** how authored content stays grounded. An optional nervous system is a contradiction.

**Decision.** Both are required, with a **fail-fast preflight**: `wicked-bus` is a static
dependency and the db is initialized at serve time; the brain check is upgraded from
"~/.wicked-brain exists" to **server liveness** with an auto-start hint. We still keep the bus's
*mechanical* guidance — idempotent handlers, explicit acks, ≥ 250 ms polls — because those are
correctness, not optionality.

**The bus is transport, not storage.** wicked-bus TTL-sweeps (24 h delete / 72 h visibility), so
durable state **always** lives in workspace files the service materializes from events. An agent
offline past the TTL recovers via `wicked-bus replay` + reconcile-from-files (versions.json /
sources.json remain authoritative). Nothing the user can lose lives only on the bus.
