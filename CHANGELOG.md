# Changelog

All notable changes to `wicked-interactive`. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

_Nothing yet._

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
