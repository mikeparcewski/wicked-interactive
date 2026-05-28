# wicked-interactive

An Interactive HTML & Presentation Builder with an **in-browser feedback loop** for
non-technical business users. Build a draft, review it in the browser, highlight blocks,
attach plain-language feedback, click **UPDATE**, and watch the draft regenerate live —
then navigate versions, fork, and export to self-contained HTML or PDF.

- **Requirements:** [`docs/requirements.md`](docs/requirements.md) (approved acceptance criteria)
- **Architecture decisions:** [`docs/adr/`](docs/adr/) (17 ADRs)

## Install

wicked-interactive is a **Claude Code plugin** — the supervising agent that fulfills
structural edits and chat (ADR-0010) _is_ the Claude Code session, so it ships where that
runtime lives. It depends on three sibling plugins (ADR-0016):

```
claude plugin install wicked-prezzie wicked-garden wicked-brain
claude plugin install wicked-interactive
```

Then, inside Claude Code, run the **`serve`** skill ("start wicked-interactive"). It boots
the local service, opens the browser, and puts the session into the `assist` loop — that
loop is what makes click-to-edit actually update. No terminal needed after launch.

## Status

**Increments 1–15 complete**, packaged as a plugin. The full business-user loop is verified
end-to-end in a real browser (`npm run acceptance`); the build gate re-derives
`tests-pass` (99), `frontend-build`, and the browser `acceptance` E2E — all PASS.

**Increment 1 — core engine.** Pure, browser-free logic:

| Module | Responsibility | ADR |
|---|---|---|
| `src/core/instrument.js` | Inject stable `data-wid` anchors into HTML | 0001 |
| `src/core/feedback-schema.js` | Parse/serialize the `_v{x}.md` feedback file | 0002 |
| `src/core/regenerate.js` | Determinism-first regeneration + INV-2/INV-3 guardrails | 0003 |
| `src/core/versions.js` | Write-once parent-pointer version manifest | 0008 |

**Increment 2 — local service** (`src/service/`). Express + SSE + chokidar: serves
versions, accepts feedback as the single atomic writer, watches for `_v{n}.md`,
regenerates, and pushes `html-updated`. The `serve` CLI is the one command a user runs.

**Increment 3 — React frontend** (`frontend/`). Block hover-select keyed to `data-wid`,
feedback panel, pending-edit overlay, the UPDATE button, SSE iframe-swap hot-reload
(ADR-0006), and the version navigation strip. The service serves the built app at `/`.

**Increment 4 — structural delegation** (`src/service/structural.js`). The service is
model-free: deterministic edits apply immediately (partial version), and
`structural-change` items are delegated to the **supervising agent** (ADR-0010) via a
request/response file protocol under `requests/`. The agent edits the fragment preserving
every `data-wid`; the service applies it through the INV-2 gate as a follow-on version.

**Increment 5 — queue + fork.** A FIFO queue serializes watcher processing so concurrent
UPDATEs never race the manifest (ADR-0007); `writeFeedback` reserves distinct version
numbers across rapid writes. `forkVersion` + `POST /api/fork` implement non-destructive
"start again from here" (ADR-0008), surfaced as a button when viewing a non-head version.

**Increment 6 — export** (`src/service/export.js`). `POST /api/export` produces a
self-contained interactive HTML (local CSS/JS/images and `url()` refs inlined as
data-URIs) or a PDF (headless Chrome `--print-to-pdf` — the primitive wicked-prezzie
wraps; ADR-0009). The renderer is injectable. Export HTML / Export PDF buttons in the UI.

**Increment 14 — multi-document.** `createMultiServer` mounts a per-doc sub-app at
`/d/:doc/`; `POST /api/docs` creates a workspace, `/api/events/all` multiplexes every
per-doc broadcast onto one operator tail (the `assist` loop watches this). The picker and
"New document" modal let a user run many docs from one service.

**Increment 15 — sibling gates + plugin packaging.** A preflight (`src/service/preflight.js`)
and in-app install-gate block until `wicked-prezzie`, `wicked-garden`, and `wicked-brain`
are present (ADR-0016). Shipped as a Claude Code plugin (`.claude-plugin/`) with the
`serve` and `assist` skills as the entry point and supervising loop.

## Develop

```bash
npm install && npm test          # core + service + frontend logic: node --test (99 tests)
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

## Structural edits (the agent in the loop)

`structural-change` feedback ("rework this with AI") is delegated to the supervising agent
via files under the workspace's `requests/` dir (ADR-0010): the service writes
`_v{n}.request.json`, the agent edits the fragment **preserving every `data-wid`** and
writes `_v{n}.response.json`, and the service finalizes it through the INV-2 gate as a
follow-on version. The service itself embeds no model.
