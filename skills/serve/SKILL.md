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

The editor needs two sibling tools — `wicked-garden` and `wicked-brain` (ADR-0016; prezzie was
absorbed into wicked-interactive itself, ADR-0020). Don't make the user install them by hand. Run
the setup script (builtin-only — runs straight from the plugin dir, no deps needed), which
installs **only what's missing** and prints every command before it runs (transparency — nothing
installed silently):

```bash
node "$WI_HOME/bin/ensure-siblings.mjs"
```

Tell the user, in plain language, what's happening — e.g. *"First run: I'm setting up the two
helper tools wicked-interactive needs (wicked-garden, wicked-brain). You'll see each install
command as it runs."* If everything is already present the script is a no-op (exit 0).

If it exits non-zero, it couldn't finish (usually `claude` isn't on PATH because you're not inside
Claude Code). It prints the exact remaining commands — relay those and stop. The in-app
install-gate is the same safety net in the browser. Respect `WI_NO_AUTOINSTALL=1`.

**Warm the brain now (ADR-0021).** wicked-brain is a REQUIRED component — it's how authored
content stays grounded in the user's real numbers and prior decisions (assist Steps 6 + 9). The
brain server auto-starts on first call, but a cold start mid-edit reads as a hang, so start it up
front: invoke the **`wicked-brain-server`** skill (or any `wicked-brain` skill, which auto-starts
it). A brain that's installed-but-down silently no-ops grounding — warming it here makes the
"grounded, not plausibly-wrong" guarantee real instead of best-effort.

## Step 2 — Pick the documents root (default = the ONE shared instance)

**Default to the canonical root `~/wicked-interactive/docs` — do NOT pick a per-session or
`/tmp` root.** This is the whole point of sharing: every session that uses the same root reuses
the *one* running bridge instead of spawning its own on another port. One instance, one URL, no
"why is it on five ports" confusion. Only choose a different root if the user explicitly wants a
**separate, isolated** instance (a distinct project that should not share docs).

```bash
DOCS="${WI_DOCS:-$HOME/wicked-interactive/docs}"; mkdir -p "$DOCS"; echo "$DOCS"
```

(`serve` with no `--root` now defaults to this same canonical root, so a bare
`wicked-interactive serve --daemon` joins the shared instance too.)

## Step 3 — Start the service in the background

The service (express + the built UI + its npm deps) runs from the **published package via
`npx`** — so it works on any machine without the cloned plugin needing `node_modules` or a
frontend build. `npx` fetches + caches the matching version, and `frontend/dist` ships inside the
package. Pin to the plugin's own version so the runtime matches the installed plugin.

First, warm the bus — it is the REQUIRED control plane (ADR-0019/0021), and this also seeds its
data dir + warms the `npx` cache so the agent's later `wicked-bus subscribe`/`emit` calls are
instant:

```bash
npx -y wicked-bus init >/dev/null 2>&1 || true
```

Start the service with **`--daemon`** — it self-detaches (survives this call without
`nohup`/`disown`), waits until the bridge answers, prints the URL, and exits. Do **not** background
it yourself; `--daemon` is the durable, cross-platform way:

```bash
npx -y "wicked-interactive@$WI_VER" serve --root "$DOCS" --daemon
```

Developing locally from the repo, where `$WI_VER` may not be published yet? Run the local binary
instead (it resolves its deps from the repo's `node_modules`):

```bash
node "$WI_HOME/bin/wicked-interactive.js" serve --root "$DOCS" --daemon
```

Read the first lines of output to learn the actual base URL — **the port is dynamic** (ADR-0022):

```
wicked-interactive (multi-doc) serving <DOCS> on http://localhost:<PORT>
```

With no `--port` the service takes the first free port from 4400 up; `--port N` is a *preference*
that falls forward to a free port if N is taken (you'll see `note: port N was taken — using <PORT>
instead`). **Always parse the printed URL — never assume 4400.** Because each `--root` gets its own
port, several sessions can serve at once without colliding.

### Reuse is identity-aware — just run it again

`serve` is idempotent per root and the reuse check is **identity-based** (ADR-0022): the running
bridge records itself in `<DOCS>/.wi-serve.json`, and `serve` hits the recorded port's
**`/api/health`** (which reports the docs root it serves). If health reports **this** root, it
reuses it (`reusing live bridge for <DOCS> on http://localhost:<PORT>`, exit 0). If something else
is on that port — a different instance, or nothing — it does **not** reuse and starts fresh on a
new free port. So you never get pointed at the wrong instance and roots never collide.

The rule is simply: **run `serve --root "$DOCS" --daemon` whenever you need the bridge** — it
reuses the live one or starts a durable new one, every time, and prints the URL. To discover a
root's bridge *without* starting anything, read `<DOCS>/.wi-serve.json` and confirm
`http://localhost:<port>/api/health` reports `root` == your `$DOCS`.

**After a reinstall/upgrade, add `--restart`:** `serve --root "$DOCS" --daemon --restart`. Reuse
would otherwise keep serving the *old* running build; `--restart` stops the existing daemon for the
root first (SIGTERM → SIGKILL if it's wedged → clears the lockfile), then starts the new version
clean. One command, no manual `kill`. (Plain SIGTERM/SIGINT also always terminates the daemon now —
it has a hard 2.5s shutdown cap so a held-open SSE connection can't wedge it.)

## Step 4 — Open the browser

Open the printed base URL. If documents already exist, open `/?doc=<name>`; otherwise
open `/` so the user lands on the empty screen.

```bash
# macOS: open   | Linux: xdg-open   | Windows: start
open "http://localhost:<PORT>/" 2>/dev/null || xdg-open "http://localhost:<PORT>/" 2>/dev/null || true
```

**If this session was spawned from an idea** (the user gave you a topic or brief), **always open
`/`** — not `/?doc=<name>` — even if other docs exist. The `assist` skill's Step 0.5 will create
the new document immediately after and the browser will auto-navigate there in working mode
(locked chat + generation veil). Opening an existing doc instead would block that auto-navigation.

Tell the user what's happening only if they need orientation:
- Spawned from an idea: `assist` handles this — no user instruction needed.
- No idea / returning user: click a doc in the sidebar, or type a brief in the chat box to start
  a new one.

## Step 5 — Enter the supervising loop (REQUIRED)

`serve` and `assist` are one experience. The service is running; now YOU become the agent
that makes it intelligent. Do this immediately — before responding to the user:

**In Claude Code:** call the `Skill` tool with `wicked-interactive:assist` as the skill
name. This is not a suggestion and not conditional. `serve` is not complete until `assist`
is running in this session.

```
Skill({ skill: "wicked-interactive:assist" })
```

**Not in Claude Code?** Tell the user: *"The builder is live at `<BASE>`. To enable chat
and structural edits, open a Claude Code session and run `/wicked-interactive:assist`."*
Then exit — do not leave them with a half-working editor.

`assist` takes over from here: it greets the user, arms the bus drain, and runs the
supervising loop until the session ends. Do not consider `serve` complete until it does.

## Step 6 — Stop it when the user is done

You started the service, so you own stopping it. When the user is finished (they say so, or
the session is wrapping up), **kill the `serve` process** (and stop the `wicked-bus subscribe`
tail you started in `assist`) so nothing is left bound to the port. A clean shutdown (SIGINT/
SIGTERM) removes that root's `.wi-serve.json` so the next `serve` knows the bridge is gone; the
lockfile is per-root, so stopping one never disturbs another session's bridge. Documents persist
on disk under `--root` and the bus is just transport, so stopping is non-destructive — restarting
`serve` later picks up right where they left off. Leave any sibling servers (wicked-brain, the
shared wicked-bus, etc.) alone.
