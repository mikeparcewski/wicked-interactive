# ADR-0015: Multi-document support

## Status
Accepted — 2026-05-28 (product-owner direction)

## Context
Through ADR-0014 the service hosts one workspace at a time (`--dir`). Real product use needs
multiple documents — users iterate on more than one brochure/slide deck, and "start a new
interactive" needs a destination that doesn't blow away the previous one. The single-dir
model is the bottleneck.

## Decision
The service now hosts a **docs root** containing one workspace per document.

### Filesystem layout
```
<root>/
  <doc-name>/
    versions.json
    _v0.html, _v0.md, _v1.html, _v1.md, ...
    requests/
    conversation.jsonl
  <other-doc>/
    ...
```
Doc names are slug-safe (lowercase, hyphens, no path separators). Each doc is a
self-contained workspace identical to today's single-workspace layout.

### CLI
- `wicked-interactive serve --root <dir>` — multi-doc mode (preferred).
- `wicked-interactive serve --dir <dir>` — legacy single-doc mode (kept for back-compat;
  the dir becomes a one-doc root with name `default`).

### Endpoints
Per-doc endpoints get a path prefix:
- `GET  /d/:doc/api/versions`
- `GET  /d/:doc/doc[/:version]`
- `POST /d/:doc/api/feedback`
- `POST /d/:doc/api/status`
- `POST /d/:doc/api/answer`
- `POST /d/:doc/api/message`
- `GET  /d/:doc/api/conversation`
- `POST /d/:doc/api/export`
- `POST /d/:doc/api/fork`
- `GET  /d/:doc/events` (per-doc SSE — isolated event streams per workspace)

Service-level (cross-doc):
- `GET  /api/docs` — list `[{name, head, versions_count, updated_at}, ...]`.
- `POST /api/docs` `{name, html}` — create a workspace and seed `_v0.html`.

### Frontend
URL routing via `?doc=<name>`. A header picker lists docs (loaded from `/api/docs`); a
"New document" modal POSTs to `/api/docs` then redirects via `?doc=<name>`. The chat
panel, version dropdown, and inline edits all scope to the current doc. Switching docs
re-points the iframe + reloads conversation + manifest.

### chokidar / watchers
One watcher per active doc (lazily started on first request to a doc), watching that
doc's directory. Per-doc events are isolated on per-doc SSE channels.

### INV-2 + engine
Unchanged. Each workspace's INV-2 contract holds within that workspace. The engine
operates on a single workspace at a time, oblivious to the registry above it.

## Consequences
- Real multi-document UX; users keep multiple drafts.
- Workers (and future external daemons) scope to a doc — they watch one workspace.
- Endpoint surface grows; tests + acceptance need updating for per-doc routing.
- Legacy single-doc CLI still works (`--dir` mode wraps as a `default` doc), so existing
  deployments and the live brochure session migrate cleanly.

## Trade-offs Accepted
A larger endpoint surface and more frontend state (current doc) in exchange for the real
product shape. URL-based doc selection keeps each tab pinned to one doc (works with the
"open in new tab" pattern for free).
