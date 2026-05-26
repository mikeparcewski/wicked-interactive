# wicked-interactive

An Interactive HTML & Presentation Builder with an **in-browser feedback loop** for
non-technical business users. Build a draft, review it in the browser, highlight blocks,
attach plain-language feedback, click **UPDATE**, and watch the draft regenerate live —
then navigate versions, fork, and export to self-contained HTML or PDF.

- **Requirements:** [`docs/requirements.md`](docs/requirements.md) (approved acceptance criteria)
- **Architecture decisions:** [`docs/adr/`](docs/adr/) (9 ADRs)

## Status

**Increment 1 — core engine (done).** Pure, browser-free logic with full unit coverage:

| Module | Responsibility | ADR |
|---|---|---|
| `src/core/instrument.js` | Inject stable `data-wid` anchors into HTML | 0001 |
| `src/core/feedback-schema.js` | Parse/serialize the `_v{x}.md` feedback file | 0002 |
| `src/core/regenerate.js` | Determinism-first regeneration + INV-2/INV-3 guardrails | 0003 |
| `src/core/versions.js` | Write-once parent-pointer version manifest | 0008 |

Later increments: local service + file-watch, React frontend + SSE hot-reload, the
fragment-scoped LLM structural path, FIFO queue + fork UI, and HTML/PDF export.

## Develop

```bash
npm install
npm test        # node --test — 27 unit tests
```

Requires Node ≥ 20.
