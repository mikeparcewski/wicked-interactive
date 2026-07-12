# Changelog

All notable changes to `wicked-interactive`. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **`src/artifact/` module** — self-contained artifact creation pipeline: `create.js`, `publish.js`, `validate.js`, `schema.js`, `template.js`. Provides `wicked-interactive create --from-crew | --from-garden | --from-file --output <path>` for generating self-contained HTML artifacts from crew sessions, garden council verdicts, or raw wi-content JSON files.
- **`--from-garden <session_id>`** — renders a wicked-garden multi-model council verdict as an interactive artifact. Reads the council transcript garden persists under `~/.something-wicked/wicked-garden/projects/<slug>/wicked-jam/transcripts/<session_id>.json` (override the root with `WICKED_GARDEN_PATH`); omit the id to use the latest. Maps the verdict → recommendation, each model → a card, and the synthesis → evidence; degrades to a "content pending" stub when no transcript resolves.

### Changed
- **Replaced `--from-signal` with `--from-garden`.** wicked-signals was archived and its routing/classification role moved to wicked-garden's council, so the signal adapter (and its dead `npm install -g wicked-signals` guidance) is gone; the artifact `source_type` `signal` is now `garden`, and the artifact-created event carries `council_session_id` instead of `signal_id`.
- **`wicked.export.generated` event schema** — validates the artifact-created payload emitted after export. Required fields: `document_id`, `version`, `format` (html/pdf/pptx), `path`, `file`.
- **`wicked.export.reviewed` event schema** — validates review-decision payloads. Required fields: `document_id`, `version`, `verdict` (approved/rejected/needs_revision).
- **`--output <path>` flag** for `wicked-interactive create` — spec-canonical flag for the output path (legacy `--out` alias retained for backward compatibility).

### Fixed
- Help text for `create` subcommand now shows `--output <path>` instead of `--out <path>`.
