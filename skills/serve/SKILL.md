---
name: serve
description: |
  Start the wicked-interactive builder: launch the local service, open the browser,
  and put THIS Claude session into the supervising-agent loop so the in-browser
  feedback loop actually works. The one command a business user runs.

  Use when: "start wicked-interactive", "open the builder", "launch the editor",
  "build an interactive page", "build a presentation I can edit in the browser",
  "let me review and edit a deck", "serve my documents", "open my docs in the browser",
  "start the interactive builder", "I want to edit HTML by clicking on it"
phase: launch
pipeline_position: 1
---

# serve — start the builder and stay in the loop

This is the single entry point. It starts the long-running local service, opens the
browser, and then **hands off to the `assist` skill** — because the in-browser feedback
loop is broken without a supervising agent (ADR-0010): structural edits and chat are
fulfilled by *this* Claude session writing response files. Starting the service without
entering the loop leaves the user clicking blocks that never update.

## Step 0 — Set up the helper tools (auto-install)

The editor needs three sibling tools — `wicked-prezzie`, `wicked-garden`, and
`wicked-brain` (ADR-0016). Don't make the user install them by hand. Run the setup
script, which installs **only what's missing** and prints every command before it runs
(transparency — nothing installed silently):

```bash
node tools/ensure-siblings.mjs
```

Tell the user, in plain language, what's happening — e.g. *"First run: I'm setting up the
three helper tools wicked-interactive needs (wicked-prezzie, wicked-garden, wicked-brain).
You'll see each install command as it runs."* If everything is already present the script
is a no-op and exits 0.

If the script exits non-zero, it couldn't finish (usually `claude` isn't on PATH because
you're not inside Claude Code). It prints the exact remaining commands — relay those to the
user and stop. The in-app install-gate is the same safety net in the browser. Respect
`WI_NO_AUTOINSTALL=1` if the user has opted out of auto-install (the script then only
reports what's missing).

## Step 1 — Ensure runtime dependencies

The service has npm runtime deps (express, chokidar, cheerio, js-yaml). A freshly
installed plugin has no `node_modules`. Install once if missing:

```bash
[ -d node_modules ] || npm install --omit=dev
```

## Step 2 — Ensure the built frontend exists

The service serves `frontend/dist`. It ships built, but rebuild if absent:

```bash
[ -f frontend/dist/index.html ] || (cd frontend && npm install && npm run build)
```

## Step 3 — Pick the documents root

Ask the user where their documents live, or default to `~/wicked-interactive/docs`.
This is THEIR workspace (one subdirectory per document), never the plugin directory.

```bash
DOCS="${WI_DOCS:-$HOME/wicked-interactive/docs}"; mkdir -p "$DOCS"; echo "$DOCS"
```

## Step 4 — Start the service in the background

Run it with `--watch` so the operator event tail prints in the same place, and capture
the port from stdout. Use a background Bash invocation (do NOT block on it):

```bash
node bin/wicked-interactive.js serve --root "$DOCS" --watch
```

Read the first lines of output to learn the actual port:

```
wicked-interactive (multi-doc) serving <DOCS> on http://localhost:<PORT>
```

The port defaults to 4400 but the OS may pick another if it's taken — always read the
printed URL rather than assuming 4400.

## Step 5 — Open the browser

Open the printed base URL. If documents already exist, open `/?doc=<name>`; otherwise
open `/` so the user lands on the document picker and the "New document" modal.

```bash
# macOS: open   | Linux: xdg-open   | Windows: start
open "http://localhost:<PORT>/" 2>/dev/null || xdg-open "http://localhost:<PORT>/" 2>/dev/null || true
```

Tell the user, in the browser-facing chat is best, but the terminal is fine here:
- New documents: click **New document**, name it, then either brainstorm in chat from a
  blank doc OR choose **Build from my files** to point at content you already have — the
  agent indexes it and drafts the document for you.
- Existing documents: click a block to comment, "Change text" for exact edits, or type
  in the assistant chat for anything bigger.

## Step 6 — Enter the supervising loop (REQUIRED)

Immediately invoke the **`assist`** skill, pointed at the same base URL. Do not consider
`serve` complete until `assist` is running — without it the UPDATE button and chat hang
forever. `assist` is what makes the agent-in-the-loop guarantee real.
