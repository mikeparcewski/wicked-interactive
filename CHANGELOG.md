# Changelog

All notable changes to `wicked-interactive`. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

_Nothing yet._

## [0.8.0] — 2026-08-19

### Changed
- **BREAKING — the standalone SPA shell is retired; the bridge is API-only** (DES-MERGE-001 slice 18, §7.13). The builder UI lives in the merged wicked-studio app. `GET /` now redirects (302) to the studio origin recorded in `<root>/.wi-serve.json`, or — with none recorded — returns a short page naming the situation and the escape hatch (never a bare 404). A `?doc=<name>` bookmark resolves to that document's studio route when the doc is project-bound. **Every `/api/*` route is unchanged**, and a parity smoke suite (`test/api-parity.test.js`) pins the surface the merged app drives.

### Added
- **`serve --standalone` (or `WI_STANDALONE=1`)** — keeps serving the retired SPA shell, for local development.
- **`serve --studio-origin <url>` and `POST /api/studio-origin`** (loopback-only) — record the origin `GET /` redirects to; wicked-crew calls the endpoint when it starts or adopts a bridge. `GET /api/studio-origin` reads it back. The origin is stored in the bridge's own `.wi-serve.json`, so there is no second writer.

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
