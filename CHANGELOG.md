# Changelog

All notable changes to `wicked-interactive`. Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **`src/artifact/` module** — self-contained artifact creation pipeline: `create.js`, `publish.js`, `validate.js`, `schema.js`, `template.js`. Provides `wicked-interactive create --from-crew | --from-signal | --from-file --output <path>` for generating self-contained HTML artifacts from crew sessions, signals, or raw wi-content JSON files.
- **`wicked.export.generated` event schema** — validates the artifact-created payload emitted after export. Required fields: `document_id`, `version`, `format` (html/pdf/pptx), `path`, `file`.
- **`wicked.export.reviewed` event schema** — validates review-decision payloads. Required fields: `document_id`, `version`, `verdict` (approved/rejected/needs_revision).
- **`--output <path>` flag** for `wicked-interactive create` — spec-canonical flag for the output path (legacy `--out` alias retained for backward compatibility).

### Fixed
- Help text for `create` subcommand now shows `--output <path>` instead of `--out <path>`.
