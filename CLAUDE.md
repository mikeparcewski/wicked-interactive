# wicked-interactive

Interactive HTML & Presentation Builder with an in-browser feedback loop for
non-technical business users. See `docs/requirements.md` (approved ACs) and
`docs/adr/` (17 architecture decisions).

## The local service — I own its lifecycle

The model-free service (ADR-0010) is the running substrate: I am its supervising
agent, so **I am responsible for starting it and stopping it**.

- **Start it** when work needs it live (testing a feature, hot-swapping a draft,
  responding to in-browser feedback). Canonical command:
  `node bin/wicked-interactive.js serve --root /tmp/wi-docs --port 4400 --watch`
  (run in the background). Docs persist on disk under `--root`, so a restart is
  non-destructive — the browser just needs a refresh.
- **Restart it after editing `src/service/**` or rebuilding `frontend/dist`** —
  the running process serves the old backend + the old static bundle until
  restarted. A 404 on a route I just added almost always means a stale process.
  Verify a restart with a quick `curl` of the changed route before reporting done.
- **Stop it in session cleanup** — kill the `serve` process (and the `wi-watch`
  tail if I started one) at the end of the session so I don't leave an orphaned
  service bound to the port. Leave the wicked-brain servers alone.

## Source indexing — always with live progress

When a user attaches reference material (the Sources panel → `sources` SSE event,
ADR-0017), I index it and **narrate every step back to the browser chat** so the
user watches it happen. This is a standing feature, not an ad-hoc favor.

The protocol (the substrate already supports all of it):

1. **Pick up the work.** New attachments push to me on the `wi-watch` tail; on
   session start, also reconcile `GET /d/<doc>/api/sources` for any `pending`
   entries left while the tail was down.
2. **Flip to `indexing`.** `POST /d/<doc>/api/sources/status {path,status:"indexing"}`.
3. **Stream progress** via `POST /d/<doc>/api/status {state:"working",message:…}` —
   this is the agent→user lane (renders as "Assistant", logs `role:agent`). Post at
   each milestone: kickoff → scale/scope decision → ingesting → done. Use a non-lock
   state like `"working"` so the doc isn't covered by the processing overlay; use
   `"complete"` on the final message.
4. **Check coverage AND freshness before ingesting.** Query the target brain first.
   Presence is not enough — **already-indexed ≠ current**. Before deciding to skip,
   compare the brain's last index time against the source's real state (`git log -1`
   for a repo, file mtimes otherwise). If the source moved since the index (new
   commits, edited docs), **re-ingest** — the batch script archives stale chunks by
   `safeName`, so a refresh doesn't duplicate. Only skip when the index genuinely
   reflects current content, and say which check let you skip.
5. **Scope sanely.** Skip `node_modules`, build artifacts (`.pyc`/`.map`), binaries,
   and vendored deps; index the high-signal surface (docs, READMEs, source). Name the
   scope decision in chat so the user can widen it.
6. **Land it.** `POST …/api/sources/status {path,status:"indexed"}` (or `"error"`),
   with a final `/api/status` `complete` message. Then draw on that brain (query with
   `--brain` if it's a different project's brain) when generating/updating the doc.

Brain choice: index into the source's natural project brain when one exists
(keeps each project's brain clean); otherwise this doc's project brain.

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
