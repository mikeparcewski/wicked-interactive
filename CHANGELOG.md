# Changelog

All notable changes to `wicked-interactive`. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- **The demo recorder preflights and provisions its browser; a missing browser is a typed,
  terminal error — never a retry loop** (F-RECON-012 BLOCKER, F-RECON-014). `npm install`
  never provisions Playwright's browser, nothing in the install chain ran `playwright install`,
  and nothing preflighted the recorder — so on a fresh machine every recording died on its first
  line (`browserType.launch: Executable doesn't exist at …/chromium_headless_shell-<rev>/…`), the
  command loop retried the deterministic failure three times in four seconds and dead-lettered
  it, the thread showed Playwright's ASCII box three times, and the studio blamed "the generation
  service". Now: (1) a launch-free **preflight** (`src/service/recorder-preflight.js`) asks the
  BUNDLED Playwright CLI what a recording needs (`install --dry-run` — headless shell **and**
  ffmpeg, which video capture requires) and checks each install location for Playwright's own
  completion marker; (2) on the first `demo.requested` the materializer **provisions** what is
  missing with that same bundled CLI (never a foreign `npx playwright`, whose version's browsers
  the bridge would not launch) — progress narrated on the thread, 10-minute cap
  (`WI_RECORDER_INSTALL_TIMEOUT_MS`), opt-out `WI_RECORDER_AUTO_INSTALL=0`; (3) every recorder
  failure is a **typed `RecorderError`** on the wire — `wicked.interactive.status.posted
  {state:"error", code, source:"recorder", retryable:false, remedy, …}` plus
  `wicked.interactive.error.raised {source:"recorder", error:<code>, context}` — with stable
  codes `recorder_browser_missing` · `recorder_browser_install_failed` · `recorder_launch_failed`
  · `recording_spec_missing` · `recording_spec_invalid` · `recording_step_failed` (names the
  step) · `recording_failed` · `recording_in_flight`, and the one-line remedy
  (`wicked-interactive doctor --install`, plus the exact `node <bundled cli> install …`); (4) the
  materializer **acks** a recording failure (one honest error per request — the same spec on
  the same machine replays the same failure) instead of throwing into the retry → dead-letter
  path; (5) **"Re-record" follows the wire**: `POST /api/events` refuses a `demo.requested`
  while one is in flight for the doc (`409 recording_in_flight`) and, with auto-install off,
  refuses it up front when the browser is missing (`503 recorder_browser_missing`) instead of a
  200 that fails seconds later; `GET /d/:doc/api/demo/status` exposes the per-doc recording
  state (`idle` · `preflight` · `installing` · `recording` · `recorded` · `failed`, with
  `error`, `step`, `progress`, `in_flight`) plus the browser snapshot; (6) `GET /api/preflight`
  carries the recorder snapshot (`recorder.ok/missing/remedy/install_command/auto_install`) so a
  skin can say so BEFORE a multi-minute spec run is spent, and `POST /api/demo/browser/install`
  provisions on demand; (7) a new CLI **`wicked-interactive doctor [--install] [--json]`**
  (alias `--check`) reports the recorder browser, the sibling install gate and crew
  reachability — exit 1 while the recorder cannot record. CI gains a `recorder-provision` job
  that runs the real path on ubuntu: doctor MISSING → `doctor --install` → READY → a real
  two-step recording.
- **Every block with visible text carries a `data-wid`** (F-RECON-004). Only the semantic tags
  (`h*`, `p`, `li`, `td`, …) were anchored, so a brochure's hero fact strip (`div > span…`),
  footer requirements block, flow badges and KPI tiles were un-pinnable: a comment pinned on the
  strip resolved to the nearest anchored block (the hero paragraph) and the design edit landed,
  with perfect anchor fidelity, on the wrong block. `instrument()` now runs a second pass that
  anchors every remaining **text block** — an element with visible text whose text is its own
  or lives in inline children — as `slide-{n}-block-{k}` (block-level tags) or
  `slide-{n}-text-{k}` (inline), skipping `aria-hidden` decoration and the new author opt-out
  `data-wi-no-anchor`. Additive: semantic ids and section anchors are unchanged (own counters),
  pre-existing ids are preserved (INV-1), re-instrumenting is a no-op. New helper
  `unanchoredTextBlocks(html)` states the invariant (empty after instrumentation).
- **No phantom versions** (F-RECON-005). A feedback batch that changed nothing — structural-only
  (the edit is the agent's to make), or deterministic edits that were all stale / rejected /
  no-ops — still landed `_v{n}.html` byte-identical to its parent and announced
  `version.created`, so the version strip, the export menu and the thread ("v3 landed") offered
  a version that changed nothing, and the real edit landed as v4. Now a version is minted only
  when the prepared bytes differ (sha-256). The unchanged batch keeps its reserved number on
  `_v{n}.md` (the handoff id crew's edit seam dedupes on — unchanged wire semantics), announces
  no `version.created`, and `feedback.processed` gains additive `landed:false` / `unchanged:true`
  / `base_version` / `feedback_file`; the follow-on `edit.completed {version:n}` resolves its base
  through the feedback file's `base_html` and lands as **v{n}** — the number the ask reserved —
  recording `feedback_file: "_v{n}.md"` on it.

## [0.9.1] — 2026-09-11

### Fixed
- **Export honours the author's page geometry — plain `<section>`s are not a slide deck**
  (F-050 / F-4R2-015). The exporter classified any document with 2+ top-level `<section>`s as a
  deck and injected `@page { size: 13.333in 7.5in }` + `100vh; overflow:hidden; break-after: page`
  onto every section — into the PDF render AND the HTML download — so a correct two-page A4
  brochure exported as 9 landscape 16:9 pages (three of them blank), and the delivered `.html`
  printed the same way from any browser. Now: (1) an author-declared `@page` is never overridden
  (only `@page` pins the paper; author `.page`/`.wi-page` wrappers or `break-after: page` are
  kept and stop the exporter from forcing one slide per page), and a doc created with `style`
  `web`/`doc`/`brochure` always exports as a document; `@page` is read from print-scoped CSS
  only — a comment, a string literal, `@media screen` or `<style media="screen">` never counts;
  (2) a deck must DECLARE itself — `[data-slide]` / `.slide` / `.wi-slide` markers at document
  level, `data-wi-kind="deck"` on a wrapper, or `style: "ppt"` — plain semantic sections never
  do; an EXPLICIT deck (`style: "ppt"` / `data-wi-kind`) that also declares `@page` keeps one
  slide per page on the author's paper; (3) the HTML export carries no print
  injection at all (document head only), and the PDF-prep copy gets page geometry only for a
  declared deck (a document gets a render-safety baseline: animations off, reveals completed,
  `print-color-adjust`); (4) `POST /api/docs` `style` is now recorded on the manifest (it was
  dropped after the `doc.created` emit) and surfaced by `GET /api/docs`; (5) the export response
  and `wicked.interactive.export.generated` carry additive `layout` (`document`|`deck`),
  `layout_source` (documented vocabulary, `LAYOUT_SOURCES`), `page_size` (measured from the
  PDF, e.g. `A4 portrait`) and `pages` so the UI can show what was produced. Behaviour change for undeclared decks: a deck built from plain
  `<section>`s now prints in its own flow — add `class="wi-slide"` (or `data-wi-kind="deck"`)
  to get 16:9 one-slide-per-page again; the skill references are updated accordingly.
- **`.codegraph/estate.db` (+ `-shm`/`-wal`) is no longer tracked** (#213). A fresh clone shipped an in-tree
  code graph that an older wicked-core adopted as the live graph and wrote into, dirtying every onboarded
  checkout; the graph is per-checkout, built by `wicked-estate index` under the daemon state home
  (wicked-core#406). The files are untracked (local copies are left on disk) and `.codegraph/` is ignored.
- **`DELETE /api/docs/:doc` outbox: `wicked.interactive.doc.retired` can no longer be lost
  forever** (#198). The tombstone write preceded the bus emit, so a failed emit (bus
  unavailable, process death in the post-write window) left the event permanently missing;
  a retry answered `already_retired` with no re-emit. Fix: an outbox marker
  (`retired-event-pending.json`) is written atomically alongside the tombstone; the service
  emits-then-clears on the happy path, and a surviving marker is drained on repeat `DELETE`
  and on boot. A repeat `DELETE` with no pending marker is byte-identical to before (same
  `already_retired` response, original `retired_at`, no `event_id`).

## [0.9.0] — 2026-09-01

### Added
- **Docs can be retired: `DELETE /api/docs/:doc`** (#189, #195). Soft tombstone honoring the
  engine's write-once lineage (INV-4/AC-22 — nothing is removed): the doc leaves the default list
  (`GET /api/docs?includeRetired=1` shows it with `retired`/`retired_at`), every per-doc surface
  answers `410 Gone` (distinct from never-existed 404), and the name stays reserved (re-create →
  409). Idempotent — a repeat DELETE answers `already_retired` with the ORIGINAL timestamp and no
  re-emit, including a concurrent repeat racing the winner's unmount. A build in flight refuses
  with reason (409 carrying the activity `{status,run}` shape). Emits
  `wicked.interactive.doc.retired` exactly once (service-owned; the UI emit bridge refuses it 403).
  Reachable through crew's proxy today; crew's governed delete route (crew#338) additionally drops
  its handoff-ledger rows.

### Changed
- The retired-doc gate skips the manifest read for mounted (live) docs — no hot-path disk I/O.

## [0.8.1] — 2026-08-24

### Added
- **Learned-theme readback: `GET /d/:docId/api/theme/learned`** (#180, #181). Serves the doc's
  learned brand tokens — `{document_id, learned_at, tokens}` — so a client can confirm that a
  "learn a theme from this URL" run actually landed, instead of inferring it from a later render.
  `learnedThemePath(docDir)` is now the single definition of where that file lives, shared by the
  writer, the version-creation apply seam, and the new route.

### Fixed
- This release closes a real gap rather than adding a nicety: wicked-studio's brand-learn readback
  (`theming/learnPoll.ts`, `learnedTheme.ts`, `brandMapper.ts`, `BrandLearn.tsx`, `ThemesMenu.tsx`,
  `ThemePage.tsx`) has shipped against this route since interactive#181 merged, while the registry
  still served 0.8.0 without it. On any machine that resolved wicked-interactive from npm, brand
  learn polled and silently never landed.

## [0.8.0] — 2026-08-19

### Changed
- **BREAKING — the standalone SPA shell is retired; the bridge is API-only** (DES-MERGE-001 slice 18, §7.13). The builder UI lives in the merged wicked-studio app. `GET /` now redirects (302) to the studio origin recorded in `<root>/.wi-serve.json`, or — with none recorded — returns a short page naming the situation and the escape hatch (never a bare 404). A `?doc=<name>` bookmark resolves to that document's studio route when the doc is project-bound. **Every `/api/*` route is unchanged**, and a parity smoke suite (`test/api-parity.test.js`) pins the surface the merged app drives.

### Added
- **`serve --standalone` (or `WI_STANDALONE=1`)** — keeps serving the retired SPA shell, for local development.
- **`serve --studio-origin <url>` and `POST /api/studio-origin`** (loopback-only) — record the origin `GET /` redirects to; wicked-crew calls the endpoint when it starts or adopts a bridge. `GET /api/studio-origin` reads it back. The origin is stored in the bridge's own `.wi-serve.json`, so there is no second writer.

## [0.7.1] — 2026-08-05

### Changed
- Dependency maintenance only (js-yaml 5, vite plugin/react 6.0.5, playwright 1.62.1). Released without a changelog entry at the time; recorded here for continuity.

## [0.7.0] — 2026-07-30

### Changed
- Dependency maintenance and evidence/acceptance-test hardening (version.created + rewind verified in the DoD gate). Released without a changelog entry at the time; recorded here for continuity.

## [0.6.0] — 2026-07-21

### Added
- **`src/artifact/` module** — self-contained artifact creation pipeline: `create.js`, `publish.js`, `validate.js`, `schema.js`, `template.js`. Provides `wicked-interactive create --from-crew <session_id> | --from-garden [<session_id>] | --from-file <path> [--output <path>]` for generating self-contained HTML artifacts from crew sessions, garden council verdicts, or raw wi-content JSON files.
- **`--from-garden <session_id>`** — renders a wicked-garden multi-model council verdict as an interactive artifact. Reads the council transcript garden persists under `~/.something-wicked/wicked-garden/projects/<slug>/wicked-jam/transcripts/<session_id>.json` (override the root with `WICKED_GARDEN_PATH`); omit the id to use the latest. Maps the verdict → recommendation, each model → a card, and the synthesis → evidence; degrades to a "content pending" stub when no transcript resolves.

### Changed
- **Replaced `--from-signal` with `--from-garden`.** wicked-signals was archived and its routing/classification role moved to wicked-garden's council, so the signal adapter (and its dead `npm install -g wicked-signals` guidance) is gone; the artifact `source_type` `signal` is now `garden`, and the artifact-created event carries `council_session_id` instead of `signal_id`.
- **`wicked.interactive.export.generated` event schema** — validates the artifact-created payload emitted after export. Required fields: `document_id`, `version`, `format` (html/pdf/pptx), `path`, `file`.
- **`wicked.interactive.export.reviewed` event schema** — validates review-decision payloads. Required fields: `document_id`, `version`, `verdict` (approved/rejected/needs_revision).
- **`--output <path>` flag** for `wicked-interactive create` — spec-canonical flag for the output path (legacy `--out` alias retained for backward compatibility).

### Fixed
- Help text for `create` subcommand now shows `--output <path>` instead of `--out <path>`.
