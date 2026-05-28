# wicked-interactive

Interactive HTML & Presentation Builder with an in-browser feedback loop for
non-technical business users. See `docs/requirements.md` (approved ACs) and
`docs/adr/` (17 architecture decisions).

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
