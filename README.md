```
           _      _            _       _       _                      _   _           
 __      _(_) ___| | _____  __| |     (_)_ __ | |_ ___ _ __ __ _  ___| |_(_)_   _____ 
 \ \ /\ / / |/ __| |/ / _ \/ _` |_____| | '_ \| __/ _ \ '__/ _` |/ __| __| \ \ / / _ \
  \ V  V /| | (__|   <  __/ (_| |_____| | | | | ||  __/ | | (_| | (__| |_| |\ V /  __/
   \_/\_/ |_|\___|_|\_\___|\__,_|     |_|_| |_|\__\___|_|  \__,_|\___|\__|_| \_/ \___|
```

# wicked-interactive

### Vibe-code your slides and docs. It's Replit for stuff you actually present.

You know how Replit lets you build an app by just *talking* to it? This is that, for the
deck you have to show the board on Monday. Open it in your browser, **point at the thing you
don't like, say what you want, and watch it change.** No code. No design tickets. No "let me
loop in the team." Just you, your draft, and a running Claude that does what you ask.

```
Point at it  →  Say it  →  Watch it change  →  (don't like it? undo, or fork and try both)
```

It's powered by your Claude Code plan. If you can describe it, you can build it.

---

## Try it in 30 seconds

> *"Make this headline punchier."*
> *"That number's wrong — it's $4.2M, not $4M."*
> *"This slide is a wall of text. Three bullets."*
> *"Make the whole thing feel premium."*
> *"Actually, build me a deck about our Q3 results from scratch."*

You click the block. You type that. You hit **UPDATE**. It happens — live, in front of you.
Every version is saved automatically, so you can rewind to any draft, or **fork** and chase
two ideas at once. When it's gorgeous, hit export and you've got a clean HTML file or a PDF
to send. Done.

## Why people actually like it

- 🖱️ **You edit by pointing.** Highlight anything, say what you want in normal words.
- ⏪ **You can't lose work.** Every change is a new saved version. Rewind anytime.
- 🍴 **Try both directions.** Fork from any version and keep them side by side.
- 📤 **Send it anywhere.** Export self-contained HTML or PDF — no broken links, nothing to install on their end.
- ✨ **Start from a blank page.** Give it a topic, get a first draft.
- 🙅 **Never see a terminal.** Once it's running, it's all browser.

## Get it running

You'll need [Claude Code](https://claude.com/claude-code). Then add wicked-interactive:

```
/plugin marketplace add mikeparcewski/wicked-interactive
/plugin install wicked-interactive
```

Now just say:

> **"start wicked-interactive"**

That's it. The first time, it quietly sets up a few helper tools it needs (you'll see exactly
what it's installing — nothing sneaky), then your browser pops open and you're off. Prefer to
install those helpers yourself? Set `WI_NO_AUTOINSTALL=1` and it'll just tell you what to run.

## Want to peek under the hood?

Totally optional. **[HOW_IT_WORKS.md](HOW_IT_WORKS.md)** explains the click-to-edit magic,
why your versions can never get corrupted, and how the AI stays in the loop. The full design
record is in [`docs/adr/`](docs/adr/) and the spec in [`docs/requirements.md`](docs/requirements.md).

---

MIT licensed — see [LICENSE](LICENSE). Built on [wicked-prezzie](https://github.com/mikeparcewski/wicked-prezzie),
[wicked-garden](https://github.com/mikeparcewski/wicked-garden), and
[wicked-brain](https://github.com/mikeparcewski/wicked-brain).
