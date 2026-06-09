# Bus-First Transport + Prezzie Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope note:** This is the master plan for a multi-subsystem migration. Phase 1 is specified at full task granularity. Phases 2–6 are locked at the decision/file-map/acceptance level and MUST each be expanded with `superpowers:writing-plans` into their own task file (`docs/superpowers/plans/`) before execution — several depend on artifacts Phase 1 produces.

**Goal:** Collapse wicked-interactive's four communication vocabularies (SSE event names, request/response JSON files, agent-facing HTTP endpoints, fire-and-forget telemetry) into one: wicked-bus events flowing both directions between the UI, the service, and the supervising agent — and absorb wicked-prezzie so brain + bus become the only required external infrastructure.

**Architecture:** The service stays model-free infrastructure and remains the **single writer of the state plane** (versions.json, _v{n}.html, conversation.jsonl, sources.json — all untouched, including INV-2/data-wid invariants). The **control plane** moves entirely onto wicked-bus v2: the agent consumes commands and emits results via `wicked-bus` CLI; the service emits/consumes via the wicked-bus Node lib and bridges events to the browser (bus→SSE fan-out, SSE stays as a dumb pipe because browsers can't read SQLite; POST→bus whitelist for UI-originated events). The bus is transport, never store: bounded TTL means durable state always lives in workspace files the service materializes from events.

**Tech Stack:** Node 20+ ESM, Express, wicked-bus@^2 (SQLite WAL, cursors, DLQ, causality, schema registry), wicked-brain (npx, ~/.wicked-brain), React + Vite frontend, Playwright. chokidar is removed.

---

## 0. Decisions taken (defaults — flag to Mike if any feels wrong)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Compatibility path | **Clean cutover per phase, no dual transport** | Plugin + npm package version-sync ships skills and service together; zero external event consumers today; "we can do a lot of clean up" is the goal |
| D2 | Bus required vs the bus docs' "always optional" stance | **Required.** Static import, hard dep, fail-fast preflight | The bus IS the product's communication channel now; an optional transport is a contradiction. Documented as a conscious deviation in ADR-0019. We still keep the mechanical guidance: idempotent handlers, explicit acks, ≥250 ms polls |
| D3 | Event domain | `wicked-interactive` (drop legacy `presentation.*` types) | v2 naming: event_type starts `wicked.`, domain = package name. Current types (`presentation.feedback.received`) violate the convention; no consumers exist to break |
| D4 | Doc routing | `payload.document_id` (+ stable functional subdomains), **never** per-doc subdomains | Filter syntax is `type@domain` only; doc names are unbounded-cardinality identity, not a functional area |
| D5 | Big payloads (first drafts > 1 MB) | Agent writes HTML to the doc workspace, event carries `html_path`; bus `max_payload_bytes` stays 1 MB | Versions land on disk anyway; keeps the bus lean. Schema-registry `cas-auto` is a fallback, not the design |
| D6 | What stays HTTP | State-plane reads (doc/version HTML, manifests, conversation, sources list, docs list, fs browser, preflight) + synchronous artifact commands (export, gif, fork, doc-create) — each artifact command also emits its fact | Commands that hand back a download URL/redirect are request/response shaped; everything conversational/async is events |
| D7 | Latency strategy | Service + agent poll at 500 ms (CLI default 1 s for agent is fine); v2 push daemon is a later opt-in | "Never poll faster than 250 ms" anti-pattern; agent think-time dominates the loop anyway. Deterministic edits go from instant to ≤ 500 ms — acceptable; daemon gets it < 10 ms if it ever isn't |
| D8 | Prezzie merge scope | Curated absorption: themes + craft references now; **HTML→PPTX pipeline as Phase 5b stretch** (vendored Python, lazy preflight like ffmpeg); rest archived | 40 skills / 25 Python modules; most superseded by the browser loop (collaborate/feedback/start), the brain (learn/search/index), or garden crews (workflow/personas). PPTX is the one big unique asset |
| D9 | wicked-prezzie repo fate | Archive: README deprecation pointer to wicked-interactive; no further releases; marketplace entry remains for old installs but plugin.json description says superseded | Not on npm (plugin-only); nothing depends on it except wicked-interactive itself |
| D10 | Request/response files | **Deleted**, not kept as audit artifacts | Bus events + DLQ + versions.json + conversation.jsonl cover forensics; fewer formats is the point |
| D11 | Version | 0.5.0 (breaking internal protocol, pre-1.0 minor) | check-version + sync-plugin-version scripts already enforce package/plugin sync |

---

## 1. Event vocabulary (the one schema everything speaks)

Domain: `wicked-interactive`. Envelope: wicked-bus v2 (`event_type`, `domain`, `subdomain`, `payload`, `idempotency_key`, `correlation_id`, `session_id`, `producer_id`). Producers: `wi-service`, `wi-agent`, `wi-ui` (UI events are enriched + emitted by the service bridge with `producer_id: "wi-ui"`).

Every payload carries `document_id` and `ts`. `correlation_id` is assigned by the bridge per user action and MUST be echoed on every derived emission (service: `withContext`; agent: `WICKED_BUS_*` env-var propagation — verify in the Phase 0 spike, fallback = `payload.correlation_id`).

| event_type | subdomain | emitted by | consumed by | payload (beyond document_id/ts) | replaces |
|---|---|---|---|---|---|
| `wicked.doc.created` | `docs` | service (after POST /api/docs) | agent (kind source/demo) | `kind, source_paths?, brief?, url?` | `generation` + `demo` SSE events, `_gen.request.json`, `_demo.request.json` |
| `wicked.feedback.submitted` | `feedback` | ui | service | `version_target, items[], author` | POST /api/feedback body + `_v{n}.md` chokidar hop |
| `wicked.feedback.processed` | `feedback` | service | agent (when `awaiting_structural > 0`), ui | `version, applied[], rejected[], stale[], awaiting_structural, structural_items[]` (selector+instruction+fragment, inline) | `processed` SSE + `_v{n}.request.json` |
| `wicked.edit.completed` | `feedback` | agent | service | `version, results[] ({selector, fragment} \| {selector, remove:true})` | `_v{n}.response.json` |
| `wicked.draft.completed` | `generation` | agent | service | `html` (< 256 KB inline) or `html_path` | `_gen.response.json` |
| `wicked.chat.posted` | `chat` | ui (role user) / agent (role agent) | agent / service→ui; service materializes conversation.jsonl | `role, text` | POST /api/message + `message` SSE |
| `wicked.question.answered` | `chat` | ui | agent | `request_id, answer` | POST /api/answer + `q{id}.answer.json` + `answer` SSE |
| `wicked.status.posted` | `status` | agent, service (demo steps) | service→ui; service logs convo | `state (processing\|working\|asking\|complete\|error), message, version?, request_id?, question?, options?` | POST /api/status + `status` SSE |
| `wicked.source.attached` | `sources` | ui | agent; service materializes sources.json | `added[] ({path, note})` | POST /api/sources + `sources` SSE |
| `wicked.source.updated` | `sources` | agent | service (materialize + bridge) | `path, status (indexing\|indexed\|error), brain?` | POST /api/sources/status |
| `wicked.demo.requested` | `demo` | ui or agent (after authoring spec) | service (Playwright record on FIFO) | `headless?` | POST /api/demo/record (both callers) |
| `wicked.version.created` | `versions` | service | ui (hot-reload), agent (work landed) | `version, parent, kind (deterministic\|structural\|generated\|fork\|demo), html_file` | `html-updated` SSE + `presentation.html.updated` |
| `wicked.export.requested` | `export` | service (fact, after HTTP export) | observers | `version, format` | `presentation.export.requested` |
| `wicked.error.raised` | (area) | service | ui, agent | `source, error, context?` | `error` SSE |

Loop safety: a **type-ownership table** in `src/service/events.js` declares who may emit each type; consumers drop events whose `producer_id` is themselves; `wicked.chat.posted` routes on `payload.role`. JSON Schemas for all types ship in `src/service/event-schemas/` and install into the bus schema registry (warn mode) at init.

Idempotency: handler-side dedupe keys are domain-natural — `edit.completed` is a no-op if the target version's successor already exists; `draft.completed` is a no-op if `_v1` exists; agent treats re-delivered `feedback.processed` for a version it already answered as a no-op (the version manifest is the truth). This preserves the existing idempotent-application semantics of structural.js/generation.js.

Subscriptions:
- service: `register --plugin wi-service --filter '*@wicked-interactive'`, Node `subscribe()` (managed loop, `maxRetries: 2`, DLQ on), handlers run through the existing `enqueue` FIFO (ADR-0007 survives).
- agent: `npx wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' --cursor-init latest --poll-interval-ms 1000` — NDJSON lines into the Monitor tool. Durable cursor = missed events replay after agent downtime (kills both the wi-watch silent-watcher failure class and the manual "reconcile pending sources" step; cursor-behind-TTL (WB-003) handling lives in the serve skill: `replay --from-event-id <oldest>` then reconcile from materialized files).

---

## 2. File structure (whole migration)

**Create**
- `src/service/events.js` — vocabulary constants, type-ownership table, UI-emittable whitelist, envelope builder (enriches document_id/ts/producer/correlation).
- `src/service/bus-client.js` — wicked-bus lib wiring: `openDb`/`loadConfig` once, `emitEvent(type, payload, ctx)`, `startServiceLoop(handlers)` (managed subscribe → FIFO), graceful shutdown. Replaces `src/service/bus.js`.
- `src/service/handlers.js` — pure event handlers: feedback.submitted → deterministic apply; edit.completed → structural apply (INV-2 gate); draft.completed → instrument+theme+land; demo.requested → recordDemo; chat/status/source materializers.
- `src/service/event-schemas/*.json` — one JSON Schema per event type.
- `src/themes/corporate-light.json`, `src/themes/midnight-purple.json`, `src/themes/warm-dark.json` — absorbed from prezzie `skills/theme/themes/`.
- `skills/assist/references/` — curated prezzie craft: `html-craft.md` (from generate/references: css-constraints, html-template, image-sourcing), `outline-method.md` (outline + Pyramid Principle), `story-arc.md`, `exec-summary.md`, `known-patterns.md` (triage references).
- `test/bus-loop.test.js`, `test/bridge.test.js` — round-trip + bridge tests under `WICKED_BUS_DATA_DIR=$(mktemp -d)`.

**Modify**
- `src/service/server.js` — delete chokidar watcher, per-doc `/events`, `/api/events/all` (+tap/topClients/heartbeat/setNoDelay), POST `/api/feedback|/api/status|/api/message|/api/answer|/api/sources|/api/sources/status|/api/demo/record`; add top-level `GET /api/events` (SSE bridge) + `POST /api/events` (emit bridge); keep state-plane GETs and synchronous artifact POSTs (fork/export/gif/docs), each now emitting its fact via bus-client.
- `src/service/structural.js`, `generation.js`, `demo.js` — consume event payloads instead of watching/writing request/response files; core logic (INV-2, instrument, theme, record) unchanged.
- `src/service/workspace.js` — `processFeedback(items)` invoked directly from handler; `_v{n}.md` write becomes an audit artifact of processing, not a trigger.
- `src/service/preflight.js` — drop `wicked-prezzie`; add `wicked-bus` DB-initialized check and brain-server liveness; install hints updated.
- `src/service/theme-source.js` — resolve from `src/themes/` (delete plugin-cache probing).
- `bin/wicked-interactive.js` — `serve` runs `init` on the bus db (idempotent) and starts the service loop; `--watch` flag removed.
- `bin/ensure-siblings.mjs` — drop prezzie entry; add `npx -y wicked-bus init` seed step; garden/brain/playwright stay.
- `frontend/src/lib/api.js` — feedback/message/answer/sources/demo-record become `postEvent(type, payload)` against `POST /api/events`; state-plane fetches unchanged.
- `frontend/src/lib/sse.js` + `hooks/useSse.js` + `App.jsx` — one `GET /api/events` stream of bus envelopes; route on `event_type`, filter on `payload.document_id`.
- `skills/serve/SKILL.md` — add bus init/status + brain warm-up to Step 1; drop prezzie from the helper-tools story; Step 5 hands off to the bus-based assist loop.
- `skills/assist/SKILL.md` — full rewrite: Step 1 = `wicked-bus subscribe` (Monitor); Steps 3–9 re-expressed as consume/emit pairs (exact CLI commands per flow); INV-2 discipline (Step 2) and grounding (Step 6), crews (Step 7) unchanged in substance.
- `package.json` — `+ wicked-bus@^2`, `− chokidar`; version 0.5.0.
- `README.md`, `CLAUDE.md`, `.claude-plugin/*` — updated story + synced version.

**Delete**
- `bin/wi-watch.mjs` (and its STALL_MS watchdog world), `src/service/bus.js` legacy EVENTS map, the request/response file protocol (`_v{n}.request/response.json`, `_gen.request/response.json`, `_demo.request.json`, `q{id}.answer.json` writers/watchers), chokidar dependency.

**Never touched (state plane / determinism core):** `src/core/instrument.js`, `regenerate.js` (INV-2), `feedback-schema.js`, `versions.js`, fork model, export, instrumentation, data-wid anchoring, version file layout.

---

## 3. Phases

### Phase 0 — Spike + foundations (~½ day) ✅ DONE 2026-06-09

**Spike findings (validated against wicked-bus 2.0.0, global install, isolated `WICKED_BUS_DATA_DIR`):**
- **A — `--payload @file`**: works (`cmd-emit.js` reads `@path` → readFileSync → JSON.parse). Use it for all agent emits.
- **B — correlation propagation**: works via **env vars only** — `WICKED_BUS_CORRELATION_ID` / `WICKED_BUS_PRODUCER_ID` (causality.js). **The CLI `emit` has NO `--correlation-id` flag.** Agent sets the env var inline (`WICKED_BUS_CORRELATION_ID=<id> wicked-bus emit …`). Decision: keep correlation best-effort; routing that matters (`document_id`, `version`) rides explicitly in the payload, so a missed correlation id never breaks the loop.
- **C — concurrent lib+CLI**: a lib `subscribe()` at `pollIntervalMs:500` + 5 concurrent CLI emits delivered all events, **zero SQLITE_BUSY** (WAL + busy_timeout 5s).

**Corrections to the integration summary (verified in source):**
- `subscribe(opts)` takes a **single options object** — `{ db, plugin, filter, handler, cursor_init?, pollIntervalMs?, batchSize?, maxRetries?, backoffMs?, onError?, onDeadLetter?, onLag? }` — NOT `(db, config, opts)`. Returns `{ stop(), getLag(), cursor_id, subscription_id }`. It's a managed **push-style callback loop** (handler throws → retry → DLQ → auto-ack), not an async iterable.
- Handler receives a **parsed** event row (`payload` already `JSON.parse`d): `{ event_id, event_type, domain, subdomain, payload, idempotency_key, emitted_at, …, correlation_id, session_id, parent_event_id, producer_id }`.
- `emit(db, config, event)` accepts `{ event_type, domain, subdomain, payload, idempotency_key?, ttl_hours?, metadata?, schema_version? }`; causality fields come from `currentContext()` (env vars / `withContext`), **not** from the event object passed by the CLI.
- `openDb(config={})`, `loadConfig(overrides={})`. Data dir via `WICKED_BUS_DATA_DIR` (highest priority).

**Env note:** `npm install` is denied in this environment (don't-ask mode); wicked-bus 2.0.0 is a global install, symlinked into `node_modules/wicked-bus` for dev resolution. `package.json` declares `wicked-bus@^2.0.0` so a normal `npm i` reproduces it.

Then land the inert plumbing.

- [ ] Spike script (throwaway, `/tmp`): emit via Node lib with `WICKED_BUS_DATA_DIR=$(mktemp -d)`; consume via `npx wicked-bus subscribe` NDJSON; confirm (a) `--payload @file` emit works, (b) env-var causality propagation carries `correlation_id` across a spawned CLI emit, (c) two processes (lib + CLI) share one DB without SQLITE_BUSY at 500 ms polls. Record findings at the top of the Phase 1 task file.
- [ ] `npm i wicked-bus@^2`; `npm uninstall chokidar` deferred to Phase 3 (watcher still live until then).
- [ ] Add `src/service/events.js` + `src/service/event-schemas/` (vocabulary from §1) with unit test `test/events.test.js` (ownership table rejects wrong-producer emits; whitelist rejects non-UI types).
- [ ] Draft ADR-0019 text (inline tag style) ready to apply with the code changes.

### Phase 1 — Service bus core + browser bridge (~1–2 days) — FULLY SPECIFIED, §4 below
Service emits every existing broadcast as a proper bus event and serves the new bridge endpoints; frontend switches to envelopes. File-watch protocol still alive underneath (deleted in Phase 3) so the system works mid-migration.

### Phase 2 — Agent loop cutover (~1–2 days)
- [ ] Rewrite `skills/assist/SKILL.md` per §2 (subscribe loop, emit commands, idempotent re-delivery rules, WB-003 recovery).
- [ ] Rewrite `skills/serve/SKILL.md` Step 1/5 (bus init + brain warm-up + new assist handoff).
- [ ] Service consumes `edit.completed`/`draft.completed`/`demo.requested`/`source.updated`/`chat.posted(agent)`/`status.posted` via `startServiceLoop` handlers (FIFO-enqueued).
- [ ] Delete `bin/wi-watch.mjs`, `/api/events/all`, agent-facing POST endpoints.
- [ ] Acceptance: full loop e2e — UI feedback → deterministic items applied + structural handed off → (scripted fake agent in test emits edit.completed) → INV-2 gate → version.created → SSE reload; chat round-trip; question/answer round-trip; demo record trigger. `test/e2e.mjs` updated.

### Phase 3 — File-protocol removal + watcher deletion (~1 day)
- [ ] `structural.js`/`generation.js`/`demo.js`/`workspace.js` event-native (no request/response file I/O); `_v{n}.md` demoted to audit write.
- [ ] Remove chokidar + `--watch`; `queue-fork.test.js`, `structural.test.js`, `generation.test.js`, `server.test.js`, `multidoc.test.js` rewritten to drive handlers directly through the FIFO (the pattern the 4dcbed5 flaky-fix already started).
- [ ] Acceptance: `npm test` green with zero references to request/response files; grep gate: `grep -rn "request.json\|response.json\|chokidar" src bin skills` returns nothing.

### Phase 4 — Prezzie absorption (~1 day)
- [ ] Copy 3 theme JSONs → `src/themes/`; `theme-source.js` resolves in-repo (delete cache probing); `theme.test.js` updated.
- [ ] Curate craft references into `skills/assist/references/` (rewrite, don't copy wholesale — keep the method, drop prezzie's workflow scaffolding); assist Step 5 points at them.
- [ ] `preflight.js` + `ensure-siblings.mjs` + `InstallGate` copy drop wicked-prezzie.
- [ ] wicked-prezzie repo: deprecation README + plugin.json description ("superseded by wicked-interactive"), archive the GitHub repo.
- [ ] Acceptance: fresh-machine `serve` flow never mentions prezzie; themes apply identically (snapshot test on themed v0).

### Phase 5 — Brain hard-wiring (~½ day) (+ 5b stretch: PPTX export, ~2–3 days, separate plan)
- [ ] `preflight.js`: brain check upgraded from "~/.wicked-brain exists" to server liveness (with auto-start hint); serve skill warms it (`wicked-brain` skills auto-start via wicked-brain-call) before opening the browser.
- [ ] Assist grounding (Step 6) + source indexing (Step 9) emit `status.posted`/`source.updated` facts so grounding is visible in the UI timeline.
- [ ] 5b (stretch, own plan): vendor prezzie's standardize→chrome-extract→triage→prep→pptx_builder Python chain under `vendor/pptx/`; `POST /api/export {format:"pptx"}`; lazy preflight with install hint (ffmpeg/GIF precedent).

### Phase 6 — Cleanup, ADRs, release (~1 day)
- [ ] ADR sweep: tag new code `(ADR-0019)` bus-only control plane (supersedes ADR-0004 fire-and-forget + ADR-0006-as-protocol + ADR-0010's file-delegation slice — SSE survives only as the browser bridge); `(ADR-0020)` prezzie absorbed; `(ADR-0021)` brain+bus required, fail-fast preflight, bus-is-transport-not-store.
- [ ] README + CLAUDE.md rewrite; demo GIF re-record if the UI story changed.
- [ ] `npm test` + `npm run acceptance` green; version 0.5.0; release CI (existing workflow); brain re-ingest of the repo (`wicked-brain` ingest → retag → compile) so the project brain reflects the new architecture.

---

## 4. Phase 1 task detail (service bus core + browser bridge)

### Task 1: bus-client emit path

**Files:** Create `src/service/bus-client.js`; Test `test/bus-client.test.js`

- [ ] **Step 1: failing test**

```js
// test/bus-client.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-"));
const { emitEvent, busDb } = await import("../src/service/bus-client.js");

test("emitEvent lands a well-formed envelope", async () => {
  const { event_id } = await emitEvent("wicked.version.created", {
    document_id: "t1", version: 1, parent: 0, kind: "fork", html_file: "_v1.html",
  }, { producer: "wi-service" });
  assert.ok(event_id > 0);
  const row = busDb().prepare("SELECT event_type, domain, subdomain, producer_id FROM events WHERE event_id=?").get(event_id);
  assert.equal(row.event_type, "wicked.version.created");
  assert.equal(row.domain, "wicked-interactive");
  assert.equal(row.subdomain, "versions");
  assert.equal(row.producer_id, "wi-service");
});

test("emitEvent rejects types the producer doesn't own", async () => {
  await assert.rejects(() => emitEvent("wicked.edit.completed", { document_id: "t1" }, { producer: "wi-service" }));
});
```

- [ ] **Step 2:** `node --test test/bus-client.test.js` → FAIL (module not found).
- [ ] **Step 3: implementation**

```js
// bus-client.js — wicked-bus wiring (ADR-0019): the bus is the control plane and is
// REQUIRED. Static import + fail-fast: if the bus can't open, serve must not start.
import { emit, subscribe, openDb, loadConfig } from "wicked-bus";
import { EVENT_TYPES, ownerOf } from "./events.js";

let _db, _config;
export function busDb() {
  if (!_db) { _config = loadConfig(); _db = openDb(_config); }
  return _db;
}

export async function emitEvent(type, payload, { producer, correlationId, sessionId } = {}) {
  const def = EVENT_TYPES[type];
  if (!def) throw new Error(`unknown event type: ${type}`);
  if (producer && !ownerOf(type).includes(producer)) throw new Error(`${producer} may not emit ${type}`);
  return emit(busDb(), _config, {
    event_type: type, domain: "wicked-interactive", subdomain: def.subdomain,
    payload: { ts: new Date().toISOString(), ...payload },
    producer_id: producer, correlation_id: correlationId, session_id: sessionId,
  });
}
```

(`events.js` from Phase 0 supplies `EVENT_TYPES` — `{ "wicked.version.created": { subdomain: "versions", owners: ["wi-service"] }, ... }` for every row of §1 — and `ownerOf`.)

- [ ] **Step 4:** test → PASS. **Step 5:** commit `feat: bus-client emit path with type ownership (ADR-0019)`.

### Task 2: service replaces broadcast() internals with bus events + SSE bridge

**Files:** Modify `src/service/server.js`; Create `test/bridge.test.js`

- [ ] **Step 1: failing test** — start `createMultiServer` against a temp root + temp `WICKED_BUS_DATA_DIR`; POST `/api/docs {name:"t1", html:"<section>hi</section>"}`; open `GET /api/events`; assert an SSE frame arrives whose `event:` is `wicked.doc.created` and whose data parses to an envelope with `payload.document_id === "t1"`.
- [ ] **Step 2:** run → FAIL (`/api/events` 404).
- [ ] **Step 3: implementation** — in `createMultiServer`: start a `subscribe()` loop (`plugin: "wi-service-bridge"`, filter `*@wicked-interactive`, `pollIntervalMs: 500`, `cursor_init: "latest"`) that writes every event as an SSE frame (`event: <event_type>`, `data: <full envelope JSON>`) to bridge clients; replace every `broadcast(name, data)`/`tap` call site with `emitEvent(...)` per the §1 mapping (per-doc `broadcast` becomes a thin shim that calls `emitEvent` during this phase; old `/events` + `/api/events/all` keep working off the same emissions until Phase 2 deletes them). 15 s heartbeat comment frames kept (one place, not two).
- [ ] **Step 4:** tests pass, including existing `server.test.js`/`multidoc.test.js` (broadcast shim keeps their assertions green this phase). **Step 5:** commit.

### Task 3: UI emit bridge

**Files:** Modify `src/service/server.js`; Test `test/bridge.test.js` (extend)

- [ ] **Step 1: failing test** — `POST /api/events {event_type:"wicked.chat.posted", payload:{document_id:"t1", role:"user", text:"hello"}}` → 200 with `{event_id}`; assert the event row exists with `producer_id: "wi-ui"` and a fresh `correlation_id`; `POST /api/events {event_type:"wicked.edit.completed", ...}` → 403 (not UI-emittable); unknown document_id → 404.
- [ ] **Step 2:** FAIL. **Step 3:** implement `POST /api/events`: whitelist via `events.js` (`uiEmittable(type)`), document existence check, envelope enrichment (`producer: "wi-ui"`, uuid `correlation_id`, server `session_id`). **Step 4:** PASS. **Step 5:** commit.

### Task 4: frontend on envelopes

**Files:** Modify `frontend/src/lib/api.js`, `frontend/src/lib/sse.js`, `frontend/src/hooks/useSse.js`, `frontend/src/App.jsx`; Test `test/frontend-sse.test.js` (parser on envelope frames), `npm run acceptance`

- [ ] **Step 1:** update `useSse` to connect to `/api/events`, dispatch on `event_type`, filter `payload.document_id === currentDoc`; map old handler names (`html-updated` → `wicked.version.created`, `processed` → `wicked.feedback.processed`, etc.).
- [ ] **Step 2:** `api.js`: `postFeedback/postMessage/postAnswer/addSources/postDemoRecord` → one `postEvent(type, payload)` helper hitting `/api/events`; state-plane fetches untouched.
- [ ] **Step 3:** `npm test` + `npm run acceptance` (builds frontend, runs `test/e2e.mjs`) → green. **Step 4:** commit. Phase-1 exit: UI runs entirely on bus envelopes; agent still on wi-watch (cutover is Phase 2).

---

## 5. Risks

| Risk | Exposure | Mitigation |
|---|---|---|
| Bus TTL (24 h delete / 72 h visibility) vs overnight idle sessions | Cursor behind window → WB-003 on poll | Bus = transport, not store (ADR-0021): all durable state in workspace files; serve skill recovers via `replay` + reconcile-from-files; sources.json/versions.json remain authoritative |
| SQLITE_BUSY with 3 writers (service lib, agent CLI, sweep) | Low volume, but WAL checkpoints | busy_timeout 5 s default, ≥ 500 ms polls, FIFO serializes service writes; spike (Phase 0) proves it |
| Event loops (service consuming own emissions via `*@wicked-interactive`) | Infinite chat/status echo | producer_id self-drop + type-ownership table; chat routes on payload.role; tested in events.test.js |
| Deterministic-edit latency (instant → ≤ 500 ms) | UX feel | Acceptable for v0.5; v2 push daemon (`subscribePushOrPoll`) documented as the upgrade path |
| Agent emit ergonomics (big JSON via CLI) | Escaping bugs | `--payload @file` everywhere in the skill; drafts go by `html_path` (D5) |
| npx cold-start per agent emit | Seconds on first call | serve skill warms `npx wicked-bus status` once at startup (same trick as today's version pin) |
| Windows | Paths, spawn | bus handles %APPDATA%; repo already uses `shell:true` spawn patterns; cross-platform rule from global CLAUDE.md applies to all skill snippets |
| Prezzie users mid-flight | Old plugin keeps working standalone | D9 deprecation is additive; wicked-interactive 0.5.0 simply stops requiring it |
| Brain server down at serve time | Sources/grounding dead | Preflight upgraded to liveness check + auto-start; fail-fast with install hint, never silent (ADR-0021) |

## 6. Acceptance (whole migration)

1. `grep -rn "wi-watch\|/api/events/all\|chokidar\|request\.json\|response\.json" src bin skills frontend/src` → empty.
2. `npm test` and `npm run acceptance` green on macOS; bus-loop integration test proves UI→service→agent→service→UI round trip with a scripted agent.
3. Fresh-machine `serve`: preflight requires garden + brain (+ bus auto-init), never prezzie; browser loop works end-to-end with the rewritten assist skill.
4. `wicked-bus status` during a session shows both subscribers with advancing cursors; killing and restarting the agent replays missed events (demonstrably: attach a source while the agent is down, restart, indexing starts unprompted).
5. Every event in the session log validates against `src/service/event-schemas/`; `wicked-bus dlq list` empty after the e2e suite.
6. ADR-0019/0020/0021 tags present at the load-bearing sites; README/CLAUDE.md tell the new story; version 0.5.0 published with plugin manifest in sync.
