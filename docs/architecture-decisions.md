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
`wicked-interactive`, ~22 `wicked.interactive.<noun>.<verb>` types — see `src/service/events.js`).
- The **service** emits/consumes via the wicked-bus Node lib (`subscribe()` managed loop →
  the existing FIFO; `emit()` for facts) and **bridges** to the browser: bus→SSE fan-out down
  (`GET /api/events`), a whitelisted `POST /api/events` up (browsers can't read SQLite, so SSE
  survives only as a dumb pipe).
- The **agent** consumes with `wicked-bus subscribe` (durable cursor → missed events replay,
  killing the silent-watcher and reconcile-pending failure classes) and emits with
  `wicked-bus emit --payload @file`.
- Loop safety: a **type-ownership table** declares who may emit each type; consumers drop
  events whose `producer_id` is themselves; `wicked.interactive.chat.posted` routes on `payload.role`.

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

## ADR-0022 — dynamic port, one bridge per root, discovered via a lockfile

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

## ADR-0023 — ChatGPT-shell UI: bottom composer, + menu (learn-a-style / reviewers)

**Status:** accepted 2026-06-11.

**Context.** The original three-pane editor (rail / canvas / right chat) buried the conversation in
a side column and hid the product's reach. The owner wanted a ChatGPT-style shell: a collapsing
sidebar, the document as the centered canvas, one fixed bottom composer with a `+` menu, and the
existing capabilities surfaced where people expect them.

**Decision.**
- **Shell.** A collapsing sidebar (open on first session via `localStorage('wi-side-seen')`, then
  collapsed and hover-expanding), the document framed as a wide centered canvas, a **fixed bottom
  composer** in its own region (top hairline, matching the sidebar edge), and the conversation as a
  **collapsible thread** floating above the composer. Reviewer verdicts render inline as a `review`
  message kind.
- **The `+` menu reuses existing seams.** *Learn a style* → `wicked.interactive.theme.requested` (website grab
  exists; a local PDF/image now flows through the same handler with `{path}` — no grab, the agent
  reads it in place, ADR-0010 line stays clean). *Attach* → the local file picker writes nothing,
  reads in place (ADR-0017). *Record* → demo creation (ADR-0018).
- **Reviewers are an agent capability, not service logic.** The UI emits
  `wicked.interactive.review.requested {reviewers, document_id}`; the service does **not** materialize it (it's
  not a command type) — it rides the bus to the supervising agent, which runs the named passes
  (`match`/`a11y`/`copy`/`qe`) against the head version and posts verdicts as
  `wicked.interactive.chat.posted {role:"review"}`. Default trigger is the explicit **Review** action; review
  is read-only (creates no version) until the user asks to apply a fix. This keeps the model/
  deterministic split intact — judgment in the agent, transport on the bus, nothing hard-coded in
  the service.

## ADR-0025 — one shared instance by default (amends ADR-0022)

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
