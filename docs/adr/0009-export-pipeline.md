# ADR-0009: Export pipeline — self-contained HTML + PDF via wicked-prezzie

## Status
Accepted — 2026-05-26 (ratifies approach; v1)

## Context
AC-24/25/26 require browser-triggered export of the working-head version to (a) a
self-contained interactive single-page HTML and (b) a PDF, reusing wicked-prezzie
primitives.

## Options Considered
**HTML inlining strategy:**
- **(a) Build-time inliner (parse + inline all assets as data-URIs) — CHOSEN.**
- (b) Browser "save complete page" — rejected: inconsistent across browsers, not
  interactive-safe.
- (c) Server zip bundle — rejected: not a single file.

## Decision
Export is a **browser action** → emits `presentation.export.requested` → the service
exports the working-head `_vN.html`.
- **HTML export:** inline all CSS, JS, fonts, and images (data-URI) into a single
  `.html` that renders and retains interactivity directly from the filesystem (no
  server).
- **PDF export:** render the self-contained HTML via Chrome-headless `--print-to-pdf`.
  *(Build-phase note, 2026-05-26: `wicked-prezzie` is a plugin/skill, not an importable
  npm library, so we call the underlying primitive — headless Chrome — directly. This is
  the same engine prezzie wraps. The renderer is injectable, so a prezzie library API can
  be swapped in later without touching callers.)*
- The resulting file path is surfaced back to the UI (AC-26).
- **PPTX is explicitly out of v1 scope.**

## Consequences
- Reuses prezzie's render/PDF primitives — no new rendering engine.
- A single-file deliverable that business users can share by attachment.
- The inliner must preserve interactive JS for the exported head; large embedded assets
  inflate file size.

## Trade-offs Accepted
Inlined single-file HTML can be large — acceptable for a share-by-file UX.
