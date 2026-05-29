# How wicked-interactive works

This is the engine-room tour for people who want to know what's happening behind the
click-to-edit experience. If you just want to *use* it, the [README](README.md) is all you
need.

- **Requirements:** [`docs/requirements.md`](docs/requirements.md) — the approved acceptance criteria
- **Architecture decisions:** [`docs/adr/`](docs/adr/) — 17 ADRs covering every load-bearing choice

## The big idea

A document is HTML. Every editable block gets a stable anchor (`data-wid`) stamped into it
once and never reassigned. When you click a block in the browser and describe a change, that
anchor is how your words get matched back to the exact element — even after the document has
been regenerated many times. Versions are write-once and chained by parent pointers, so
nothing you make can ever be overwritten or lost.

The local service is **deliberately model-free** (ADR-0010). It watches files, applies
mechanical edits, serves versions, and hot-reloads the browser. The *intelligence* — the part
that rewrites a paragraph or redesigns a section — is the supervising Claude Code session
sitting in the `assist` loop. That separation is why edits are predictable: a typo fix is a
deterministic transform that can't go rogue, and a creative rewrite is delegated to the agent
through a strict, anchor-preserving protocol.

## The invariants that keep edits safe

- **INV-1** — an existing `data-wid` is never reassigned to a different element.
- **INV-2** — every pre-existing `data-wid` must survive a regeneration. The gate in
  `regenerate.js` *rejects* any edited fragment that dropped an anchor, so a botched edit
  fails loudly instead of silently corrupting the document.
- **INV-4** — versions are write-once. Edits always produce a new version; the old one stays.

## Built in increments

**Increment 1 — core engine.** Pure, browser-free logic:

| Module | Responsibility | ADR |
|---|---|---|
| `src/core/instrument.js` | Inject stable `data-wid` anchors into HTML | 0001 |
| `src/core/feedback-schema.js` | Parse/serialize the `_v{x}.md` feedback file | 0002 |
| `src/core/regenerate.js` | Determinism-first regeneration + INV-2/INV-3 guardrails | 0003 |
| `src/core/versions.js` | Write-once parent-pointer version manifest | 0008 |
| `src/core/theme.js` | Turn theme tokens into a per-version base `<style>` | 0011/0016 |

**Increment 2 — local service** (`src/service/`). Express + SSE + chokidar: serves
versions, accepts feedback as the single atomic writer, watches for `_v{n}.md`,
regenerates, and pushes `html-updated`. The `serve` skill is the one command a user runs.

**Increment 3 — React frontend** (`frontend/`). Block hover-select keyed to `data-wid`,
feedback panel, pending-edit overlay, the UPDATE button, SSE iframe-swap hot-reload
(ADR-0006), and the version navigation strip. The service serves the built app at `/`.

**Increment 4 — structural delegation** (`src/service/structural.js`). Deterministic edits
apply immediately (partial version); `structural-change` items are delegated to the
**supervising agent** (ADR-0010) via a request/response file protocol under `requests/`. The
agent edits the fragment preserving every `data-wid`; the service applies it through the INV-2
gate as a follow-on version.

**Increment 5 — queue + fork.** A FIFO queue serializes watcher processing so concurrent
UPDATEs never race the manifest (ADR-0007); `writeFeedback` reserves distinct version numbers
across rapid writes. `forkVersion` + `POST /api/fork` implement non-destructive "start again
from here" (ADR-0008), surfaced as a button when viewing a non-head version.

**Increment 6 — export** (`src/service/export.js`). `POST /api/export` produces a
self-contained interactive HTML (local CSS/JS/images and `url()` refs inlined as data-URIs)
or a PDF (headless Chrome `--print-to-pdf`, the primitive wicked-prezzie wraps; ADR-0009). The
renderer is injectable.

**Increment 14 — multi-document.** `createMultiServer` mounts a per-doc sub-app at `/d/:doc/`;
`POST /api/docs` creates a workspace, `/api/events/all` multiplexes every per-doc broadcast
onto one operator tail (the `assist` loop watches this). The picker and "New document" modal
let a user run many docs from one service.

**Increment 15 — sibling gates + plugin packaging.** A preflight (`src/service/preflight.js`)
and in-app install-gate block until `wicked-prezzie`, `wicked-garden`, and `wicked-brain` are
present (ADR-0016). Shipped as a Claude Code plugin (`.claude-plugin/`) with the `serve` and
`assist` skills as the entry point and supervising loop.

## Theme, crews, and knowledge (ADR-0016)

Three capabilities ride on the sibling plugins:

- **Theme** — every version carries a base `<style>` derived from wicked-prezzie's theme
  tokens, injected first as a genuine base layer so a document's own styling still wins. Pure
  core emits the CSS; the service resolves tokens from the prezzie plugin cache with a bundled
  fallback.
- **Crews** — multi-discipline requests ("make the whole thing investor-ready") are routed by
  the agent to a wicked-garden crew (plan → build → review) instead of a single shallow edit.
- **Knowledge** — before a generative edit, the agent consults wicked-brain so authored
  content stays true to prior decisions and your real numbers.

The last two are agent-loop behaviors (the service embeds no model), codified in the `assist`
skill.

## The structural-edit protocol (the agent in the loop)

`structural-change` feedback ("rework this with AI") is delegated to the supervising agent via
files under the workspace's `requests/` dir (ADR-0010):

1. The service writes `_v{n}.request.json` with each targeted fragment's current markup.
2. The agent edits the fragment **preserving every `data-wid`** and writes
   `_v{n}.response.json`.
3. The service finalizes it through the INV-2 gate as a follow-on version and hot-reloads the
   browser.

The service itself embeds no model — the supervising Claude session *is* the intelligence.

## Develop

```bash
npm install && npm test          # core + service logic: node --test
npm run acceptance               # browser-driven E2E (builds frontend, drives Chrome)

cd frontend && npm install
npm run dev                       # Vite dev server, proxies to the service on :4400
npm run build                     # production build into frontend/dist (shipped committed)

# run the multi-doc service directly (the serve skill wraps this):
npm run build --prefix frontend
node bin/wicked-interactive.js serve --root ~/wicked-interactive/docs --watch
```

Requires Node ≥ 20. PDF export and the acceptance test need a Chrome/Chromium binary
(`WI_CHROME` to override the path).
