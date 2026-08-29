```
           _      _            _       _       _                      _   _           
 __      _(_) ___| | _____  __| |     (_)_ __ | |_ ___ _ __ __ _  ___| |_(_)_   _____ 
 \ \ /\ / / |/ __| |/ / _ \/ _` |_____| | '_ \| __/ _ \ '__/ _` |/ __| __| \ \ / / _ \
  \ V  V /| | (__|   <  __/ (_| |_____| | | | | ||  __/ | | (_| | (__| |_| |\ V /  __/
   \_/\_/ |_|\___|_|\_\___|\__,_|     |_|_| |_|\__\___|_|  \__,_|\___|\__|_| \_/ \___|
```

> The wicked family's **document engine**. One local service owns document storage with write-once version lineage and forking, renders and exports HTML / PDF / native PowerPoint / video, records narrated demo walkthroughs, and learns themes from your existing brand pages. [wicked-crew](https://github.com/mikeparcewski/wicked-crew) spawns it as a local bridge and reverse-proxies its API; [wicked-studio](https://github.com/mikeparcewski/wicked-studio) is where you point, edit, rewind, fork, and export. You depend on it — you don't visit it.

## What lives here

The builder **UI** moved to wicked-studio (see [Moving?](#moving-the-builder-ui-now-lives-in-wicked-studio) below). The **engine** did not move — this repo is its sole implementation:

- 📦 **Documents & lineage** — every change is a write-once saved version; rewind to any of them, or fork a version and chase two ideas at once without losing either.
- 📤 **Exports** — self-contained HTML, PDF, native editable PowerPoint (`vendor/pptx/html_to_pptx.py`), and video. Nothing for the recipient to install.
- 🎬 **Demo recording** — narrated walkthroughs of a live app with chapter thumbnails (`src/service/demo.js`): mp4, poster, GIF.
- 🎨 **Theme learning** — an SSRF-hardened theme-grab over pages you already ship, plus the learned-theme readback (`GET /d/:docId/api/theme/learned`, v0.8.1) that studio's brand tooling polls.
- 🔌 **One HTTP API + one bus vocabulary** — the `/api/*` surface and the `wicked.interactive.*` event types (ADR-0019) that the studio UI and supervising agents both speak.

<p align="center">
  <img src="https://raw.githubusercontent.com/mikeparcewski/wicked-interactive/main/assets/wicked-interactive-demo.gif" alt="The builder loop this engine powers: describe a page in chat, watch it build live, point at text to change it, and rewind any version" width="100%">
</p>

*The loop in the demo — describe, point, fix, rewind — is powered by this engine; the surface you drive it from is wicked-studio.*

## How it runs

You normally never start this service yourself:

1. **Through crew — the supported path.** `npx wicked-crew serve` (studio's UI is bundled) spawns this package from npm as a local bridge (`wicked-interactive@^0.8.1`, one bridge per project docs root) and reverse-proxies its entire HTTP surface at `/api/v1/projects/:projectId/interactive/*` on crew's own origin — pure transport, SSE streamed unbuffered both ways. The studio client only ever talks to crew.
2. **Directly, as an API.** `npx wicked-interactive serve --root ~/wicked-interactive/docs` runs the API-only service on a dynamic port (ADR-0022/0025). `GET /` redirects to the recorded studio origin; there is no bundled UI on the supported path.
3. **The dev escape hatch.** `wicked-interactive serve --standalone` (or `WI_STANDALONE=1`) serves the retired SPA shell for local development of the engine itself — not the supported UI.

The package also ships a CLI for artifact work — `wicked-interactive create | publish | validate | adopt` — and Claude Code skills (`serve`, `assist`) that put an agent session into the supervising loop the feedback cycle needs (ADR-0010). The plugin install is two steps:

```
/plugin marketplace add mikeparcewski/wicked-interactive
/plugin install wicked-interactive
```

## Moving? The builder UI now lives in wicked-studio

If you used the standalone builder UI — the page this service served at `http://localhost:<port>/` —
here's what changed and where things went.

**The UI moved, the documents didn't.** Everything you've made stays exactly where it was (your
docs root, versions and all). The builder is now a mode inside the merged **wicked-studio** app,
which is where you point, comment, rewind, fork, export and record from. Nothing was dropped in the
move: the [merge design](https://github.com/mikeparcewski/wicked-studio)'s parity ledger had to be
green before this landed.

**This service is API-only now.** It still runs, still owns your documents, and still answers every
`/api/*` route — it just doesn't serve a UI:

- `GET /` **redirects** to the studio origin recorded in `<docs-root>/.wi-serve.json`. wicked-crew
  records that origin when it starts or adopts this bridge; you can also record it yourself with
  `POST /api/studio-origin {"origin":"http://localhost:4200"}` or start the service with
  `--studio-origin <url>`.
- With no origin recorded, `GET /` returns a short page saying so — never a blank 404.
- A `?doc=<name>` bookmark still works: a document that belongs to a project lands on that
  document in studio; anything else lands on the board.

**Want the old shell back?** It's still in the box, for local development:

```bash
wicked-interactive serve --root ~/wicked-interactive/docs --standalone   # or WI_STANDALONE=1
```

That serves the retired SPA exactly as before. It is a development escape hatch, not the
supported path — the merged app is where the UI is maintained.

**One capability has no button in studio yet:** *analyze / review* (the reviewer pass over a
document). It remains fully reachable over the API — `POST /api/events` with
`wicked.interactive.review.requested` — and the affordance for it belongs to the studio side.

## Why this repo stays live

Asked and answered (twice — 2026-08-24 parity audit, re-verified 2026-08-29; the full record is
ADR-0027 in [`docs/architecture-decisions.md`](docs/architecture-decisions.md)): the UI merge did
**not** move the engine, so this repo cannot be archived. crew resolves `wicked-interactive@^0.8.1`
from the public npm registry at runtime — archiving would strand a live dependency, deprecating
would announce a migration that never happened, and unpublishing would kill every route under
crew's interactive proxy. The repo stays live, reworded to the engine story it now is.

## Requirements

- Node.js ≥ 20.0.0 (for the wicked-bus peer)
- [wicked-bus](https://github.com/mikeparcewski/wicked-bus) ≥ 2.3.0 — the event backbone the service, studio UI, and agents all share (`npm i -g wicked-bus`); auto-installed on first run if not already present
- macOS, Linux, or Windows
- For the agent-supervised loop: [Claude Code](https://claude.com/claude-code) ≥ 1.0 (the plugin surface)

---

MIT licensed — see [LICENSE](LICENSE). Part of the [wicked-*](https://wickedagile.com) family of local-first, AI-native developer tools — the foundation document engine beneath wicked-crew and wicked-studio.
