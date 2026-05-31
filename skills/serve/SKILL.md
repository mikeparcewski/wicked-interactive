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

## Step 0 — Locate the plugin

Everything below runs the plugin's own files by **absolute path**, so it works no matter the
user's current directory (an installed plugin's CWD is the user's project, not the plugin). Set
these once:

```bash
WI_HOME="${CLAUDE_PLUGIN_ROOT:-$PWD}"                       # plugin dir when installed; repo when developing
WI_VER="$(node -p "require('$WI_HOME/package.json').version")"
```

## Step 1 — Set up the helper tools (auto-install)

The editor needs three sibling tools — `wicked-prezzie`, `wicked-garden`, and `wicked-brain`
(ADR-0016). Don't make the user install them by hand. Run the setup script (builtin-only — runs
straight from the plugin dir, no deps needed), which installs **only what's missing** and prints
every command before it runs (transparency — nothing installed silently):

```bash
node "$WI_HOME/bin/ensure-siblings.mjs"
```

Tell the user, in plain language, what's happening — e.g. *"First run: I'm setting up the three
helper tools wicked-interactive needs (wicked-prezzie, wicked-garden, wicked-brain). You'll see
each install command as it runs."* If everything is already present the script is a no-op (exit 0).

If it exits non-zero, it couldn't finish (usually `claude` isn't on PATH because you're not inside
Claude Code). It prints the exact remaining commands — relay those and stop. The in-app
install-gate is the same safety net in the browser. Respect `WI_NO_AUTOINSTALL=1`.

## Step 2 — Pick the documents root

Ask the user where their documents live, or default to `~/wicked-interactive/docs`. This is
THEIR workspace (one subdirectory per document), never the plugin directory.

```bash
DOCS="${WI_DOCS:-$HOME/wicked-interactive/docs}"; mkdir -p "$DOCS"; echo "$DOCS"
```

## Step 3 — Start the service in the background

The service (express + the built UI + its npm deps) runs from the **published package via
`npx`** — so it works on any machine without the cloned plugin needing `node_modules` or a
frontend build. `npx` fetches + caches the matching version, and `frontend/dist` ships inside the
package. Pin to the plugin's own version so the runtime matches the installed plugin. Run it
with `--watch` as a background Bash invocation — do NOT block on it:

```bash
npx -y "wicked-interactive@$WI_VER" serve --root "$DOCS" --watch
```

Developing locally from the repo, where `$WI_VER` may not be published yet? Run the local binary
instead (it resolves its deps from the repo's `node_modules`):

```bash
node "$WI_HOME/bin/wicked-interactive.js" serve --root "$DOCS" --watch
```

Read the first lines of output to learn the actual port:

```
wicked-interactive (multi-doc) serving <DOCS> on http://localhost:<PORT>
```

The port defaults to 4400 but the OS may pick another if it's taken — always read the printed
URL rather than assuming 4400.

## Step 4 — Open the browser

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

## Step 5 — Enter the supervising loop (REQUIRED)

Immediately invoke the **`assist`** skill, pointed at the same base URL. Do not consider
`serve` complete until `assist` is running — without it the UPDATE button and chat hang
forever. `assist` is what makes the agent-in-the-loop guarantee real.

## Step 6 — Stop it when the user is done

You started the service, so you own stopping it. When the user is finished (they say so, or
the session is wrapping up), **kill the `serve` process** (and the `wi-watch` tail if you
started one) so nothing is left bound to the port. Documents persist on disk under `--root`,
so stopping is non-destructive — restarting `serve` later picks up right where they left off.
Leave any sibling servers (wicked-brain, etc.) alone.
