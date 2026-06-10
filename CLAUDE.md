# wicked-interactive

Interactive HTML & Presentation Builder with an in-browser feedback loop for
non-technical business users. Inline `(ADR-00NN)` tags throughout the code mark
the load-bearing decisions; this file is the operating manual for the
supervising agent.

## Working on this plugin locally

**Runtime behavior lives in the skills, not here.** How the supervising agent starts the
service, runs the in-browser loop, indexes attached sources, and records demos is defined
entirely by the shipped skills — `skills/serve/SKILL.md` and `skills/assist/SKILL.md`. That's
what an installed user actually gets (this `CLAUDE.md` never loads for them). **Change agent
behavior in the skills; this file is only dev guidance for working on the repo.**

**The control plane is wicked-bus (ADR-0019).** The UI, the service, and the agent all speak
one event vocabulary (`src/service/events.js`, domain `wicked-interactive`). The service bridges
the bus to the browser (`GET /api/events` SSE down, `POST /api/events` up) and consumes commands
via two `subscribe()` loops; the agent uses `wicked-bus subscribe`/`emit`. The state plane
(versions, INV-2/`data-wid`, fork model) is unchanged — only the trigger/announce path is the bus.
The bus is transport, not storage (TTL-swept), so durable state always lives in workspace files.
See `docs/architecture-decisions.md` for ADR-0019/0020/0021.

When developing/testing locally I run the service myself:

- **Start it:** `node bin/wicked-interactive.js serve --root /tmp/wi-docs --port 4400`
  (in the background; no more `--watch` — chokidar is gone). Docs persist under `--root`, so a
  restart is non-destructive. The service opens the bus fail-fast on start (ADR-0021).
- **Restart after editing `src/service/**` or rebuilding `frontend/dist`** — the running
  process serves the old backend + old static bundle until restarted; a 404 on a route I just
  added almost always means a stale process. Verify with a quick `curl` of the changed route.
- **Watch the loop:** `wicked-bus subscribe --plugin dev --filter '*@wicked-interactive' --cursor-init latest`
  tails every event (replaces the old `wi-watch` tail).
- **Stop it when done** — kill the `serve` process so nothing is left bound to the port. Leave
  the shared wicked-bus and wicked-brain servers alone.

## wicked-brain

Digital brain: wicked-interactive | 106 indexed items | 103 chunks, 0 wiki articles, 1 memory

**Domain expertise:** interactive-html, presentation-builder, data-wid anchoring,
in-browser-feedback, versioned-markdown-feedback, determinism-first-regeneration,
wicked-prezzie reuse, wicked-bus event-spine, iframe-hot-reload, version-fork-model,
self-contained-export, react-frontend, architecture-decision-records

**Knowledge gaps:** none yet (fresh ingest of requirements + ADRs; no implementation indexed)

**Linked brains:** none

### How to use

- **Search/explore**: use `wicked-brain:search` — replaces Grep, Glob, and Agent(Explore) for open-ended search
- **Answer questions**: use `wicked-brain:query` — replaces Agent(Explore) for conceptual questions
- **Surface context**: call `wicked-brain:agent` (context) at the start of any new topic
- **Capture learnings**: call `wicked-brain:agent` (session-teardown) at session end
- **Store a decision/pattern/gotcha**: call `wicked-brain:memory` (store mode)
- **Available agents**: consolidate, context, session-teardown, onboard (via `wicked-brain:agent`)

### Search result source types

- **`wiki`** — Synthesized knowledge. Read deeper with `wicked-brain:read {path} depth=2`.
- **`chunk`** — Raw indexed content. The search excerpt is usually sufficient.
- **`memory`** — Experiential learnings. Compact; excerpt is usually enough.

### Rules (follow strictly)

- **ALWAYS check the brain BEFORE using Grep, Glob, Read, or Agent(Explore)** — for any find, search, explore, explain, or "what is/how does" request
- Use `wicked-brain:search` for finding content; `wicked-brain:query` for questions
- Use `wicked-brain:agent` (context) when starting a new topic or unfamiliar area
- Only fall back to Grep/Glob for **exact pattern matching** after the brain returns no results
- Do NOT read brain files directly — always go through skills and agents
- Always pass `session_id` with search/query calls for access tracking
- Capture non-obvious decisions, patterns, and gotchas with `wicked-brain:memory`
- When search results include `source_type: wiki`, follow up with `wicked-brain:read` at depth 1-2
