---
id: wicked-interactive-adr-0027
title: "Reword, don't archive: this repo stays live as the family's document engine"
status: active
date: 2026-08-29
---
# ADR-0027 — Reword, don't archive: this repo stays live as the family's document engine

**Status:** accepted 2026-08-29 (recon docs-R12 / OQ-3; re-verifies and closes the 2026-08-24
parity audit's open gate).

**Context.** The endgame-consolidation program asked whether wicked-interactive can be archived
on GitHub/npm now that the builder UI lives in wicked-studio. The 2026-08-24 parity audit said
no, with one hard gate open: repo HEAD carried the learned-theme readback route
(`GET /d/:docId/api/theme/learned`, #181) that wicked-studio HEAD consumes, while npm latest was
still 0.8.0 — the repo was owed a release, not a retirement. Re-verified 2026-08-29:

- **The release gate is closed.** npm latest = **0.8.1**, published 2026-08-25T02:30Z
  (`npm view wicked-interactive time`); repo tag `v0.8.1` = `10b774f`; the only commit past it
  on `main` is site-only (`5f18990`, the wi.wickedagile.com → studio redirect). Every engine
  capability at HEAD is published.
- **Archive parity still does NOT hold — the engine never moved.** The 2026-08-18 merge retired
  only the SPA shell. Sole-implementation in this repo, today: document storage with write-once
  version lineage + fork, HTML/PDF export, native-PPTX export (`vendor/pptx/html_to_pptx.py`),
  demo recording (`src/service/demo.js`, Playwright + ffmpeg), SSRF-hardened theme-grab
  (`src/service/theme-grab.js`), the learned-theme readback, and the four CLI artifact
  subcommands (`bin/wicked-interactive.js` dynamic-imports `src/artifact/*`). Neither crew nor
  studio carries any of it: crew's `interactive/proxy-routes.ts` is a self-described
  **PURE TRANSPORT** reverse proxy, and crew *spawns this package from the public npm registry
  at runtime* — `INTERACTIVE_SPEC = 'wicked-interactive@^0.8.1'` (`bridge-pool.ts:59`) feeding
  `npx --yes` (`bridge-pool.ts:311`).

**Decision.** **Reword, don't archive.** Every surface tells the document-engine story (this
pass: the README headline and the GitHub repo description; the apex and garden site cards are
fixed in their own repos), and the repo + npm package stay fully live. Archiving the repo would
strand development of a package crew resolves at runtime; `npm deprecate` would announce a
migration that never happened; unpublishing would kill every route under crew's interactive
proxy — the entire creator surface at once. Revisit only if the engine itself is ever rehomed;
the nearer-term open item is making the spawn a real crew dependency with a lockfile entry
rather than a registry-resolved `npx` spec.
