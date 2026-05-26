# wicked-interactive

An Interactive HTML & Presentation Builder with an **in-browser feedback loop** for
non-technical business users. Build a draft, review it in the browser, highlight blocks,
attach plain-language feedback, click **UPDATE**, and watch the draft regenerate live —
then navigate versions, fork, and export to self-contained HTML or PDF.

- **Requirements:** [`docs/requirements.md`](docs/requirements.md) (approved acceptance criteria)
- **Architecture decisions:** [`docs/adr/`](docs/adr/) (9 ADRs)

## Status

Increments 1–5 done. Remaining: HTML/PDF export, acceptance test.

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

## Develop

```bash
npm install && npm test          # core + service: node --test (51 tests)

cd frontend && npm install
npm run dev                       # Vite dev server, proxies to the service on :4400
npm run build                     # production build into frontend/dist

# run the whole thing:
npm run build --prefix frontend
node bin/wicked-interactive.js serve --dir /path/to/workspace --html draft.html
```

Requires Node ≥ 20.
