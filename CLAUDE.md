# wicked-interactive

The wicked family's **document engine** — an API-only local service. It owns document storage
with write-once version lineage and forking (`data-wid` anchoring), renders and exports
HTML / PDF / native PowerPoint / video, records narrated demos, and learns themes. It has **no
supported UI of its own**: wicked-crew spawns it as a local bridge and reverse-proxies its HTTP
surface at `/api/v1/projects/:projectId/interactive/*`, and wicked-studio is where people point,
edit, rewind, fork and export. Inline `(ADR-00NN)` tags mark the load-bearing decisions
(`docs/architecture-decisions.md`); this file is dev guidance for working on the repo.

## What runs where (today)

- **Supported path:** `npx wicked-crew serve` spawns this package from npm (crew's
  `INTERACTIVE_DEFAULT_RANGE`, overridable with `WICKED_INTERACTIVE_SPEC`) and proxies it. The
  studio client only ever talks to crew.
- **Direct, as an API:** `wicked-interactive serve [--root <docs-dir>]` — `GET /` redirects to the
  studio origin recorded in `<root>/.wi-serve.json` (or answers a short page saying none is
  recorded: "it serves the API, not the UI"); every `/api/*` route answers as before.
- **Dev escape hatch only:** `--standalone` (or `WI_STANDALONE=1`) serves the retired SPA shell from
  `frontend/dist`. Use it to develop the engine; never treat it as the product UI or add features
  to it — UI work belongs in wicked-studio.
- **One capability has no studio button yet:** analyze / review — reachable over the API
  (`POST /api/events` with `wicked.interactive.review.requested`).

## The control plane is wicked-bus (ADR-0019, ADR-0021)

The studio UI (through crew), the service and supervising agents speak one event vocabulary
(`src/service/events.js`, `src/service/event-schemas/`, domain `wicked-interactive`). The service
bridges the bus to HTTP (`GET /api/events` SSE down, a whitelisted `POST /api/events` up) and
consumes commands via `subscribe()` loops; an agent uses `wicked-bus subscribe`/`emit`. The state
plane (versions, INV-2 / `data-wid`, the fork model) lives in workspace files — the bus is
transport, not storage (TTL-swept). The service opens the bus fail-fast before it accepts traffic
(`server.js`, ADR-0021). Crew-governed generation answers these bus events too
(`wicked.interactive.doc.created` → a governed run → `wicked.interactive.draft.completed`).

## Working on this repo locally

**Runtime behaviour an installed user gets lives in the shipped skills** (`skills/serve/SKILL.md`,
`skills/assist/SKILL.md`), not here — this file never loads for them. Note those skills still
describe the retired in-browser builder loop; treat them as legacy until they are rewritten for
the API-only engine, and don't copy their UI claims into new docs.

- **Start it:** `node bin/wicked-interactive.js serve --root "$TMPDIR/wi-docs"` (in the
  background). The port is dynamic — first free from 4400 up; `--port N` is a preference that
  falls forward (ADR-0022/0025) — and the live port is in `<root>/.wi-serve.json`. Docs persist
  under `--root`, so a restart is non-destructive. Add `--standalone` only when you need the old
  shell to poke at the engine by hand.
- **Restart after editing `src/service/**`** (or rebuilding `frontend/dist` for the dev shell) —
  a running process serves the old backend until restarted; a 404 on a route you just added almost
  always means a stale process. Verify with a quick `curl` of the changed route.
- **Watch the loop:** `wicked-bus subscribe --plugin dev --filter '*@wicked-interactive' --cursor-init latest`
  tails every event.
- **Tests:** `npm test` (`node --test test/*.test.js`).
- **Stop it when done** — kill the `serve` process you started so nothing stays bound to the port.
  Leave the shared wicked-bus server alone.
