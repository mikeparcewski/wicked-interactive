```
           _      _            _       _       _                      _   _           
 __      _(_) ___| | _____  __| |     (_)_ __ | |_ ___ _ __ __ _  ___| |_(_)_   _____ 
 \ \ /\ / / |/ __| |/ / _ \/ _` |_____| | '_ \| __/ _ \ '__/ _` |/ __| __| \ \ / / _ \
  \ V  V /| | (__|   <  __/ (_| |_____| | | | | ||  __/ | | (_| | (__| |_| |\ V /  __/
   \_/\_/ |_|\___|_|\_\___|\__,_|     |_|_| |_|\__\___|_|  \__,_|\___|\__|_| \_/ \___|
```

# wicked-interactive

**Fix your slides and docs by pointing at them and saying what you want. No code. No tickets. No waiting on the design team.**

Open your draft in the browser. See something you don't like? Click it and say it in plain
English — *"make this punchier," "this number is wrong," "turn this wall of text into three
bullets," "make it feel premium."* Hit **UPDATE** and watch it change. Don't like the result?
Roll back. Want to try a bolder direction? Fork it and keep both. When it's right, export a
single self-contained HTML file or a PDF and send it.

A Claude Code plugin for the people who own the content but were never handed the keys.

## Say it, see it

| You're looking at... | You say... |
|---|---|
| A clunky headline | *"make this shorter and bolder"* |
| A wrong figure | *"change $4M to $4.2M"* |
| A dense paragraph | *"turn this into three bullets"* |
| A flat section | *"make this feel premium"* |
| A whole rough deck | *"tighten the story and make it investor-ready"* |
| A blank page | *"build me a deck about our Q3 results"* |

> **The thing that surprises people:** you never touch a terminal. Highlight, type, click —
> the AI does the rewrite, and *every* version is saved automatically. Nothing you make can be
> lost, and you can always go back to any earlier draft.

## Install

You'll need [Claude Code](https://claude.com/claude-code). wicked-interactive leans on three
sibling tools — install them first, then the builder itself:

```
# 1. The presentation engine — themes, deck generation, HTML → PDF
/plugin marketplace add mikeparcewski/wicked-prezzie
/plugin install wicked-prezzie

# 2. The crews that handle big redesigns
/plugin marketplace add mikeparcewski/wicked-garden
/plugin install wicked-garden

# 3. Project memory, so edits stay true to your facts
npx wicked-brain

# 4. wicked-interactive itself
/plugin marketplace add mikeparcewski/wicked-interactive
/plugin install wicked-interactive
```

Then just say **"start wicked-interactive."** It opens your browser, and gets out of your way.
(If anything's missing, the app tells you exactly what to run — no guessing.)

## What you can do

- **Edit by pointing.** Click any block, describe the change, watch it happen live.
- **Never lose a draft.** Every change is a new saved version. Step back and forth freely.
- **Try two directions.** Fork from any version and keep both alive side by side.
- **Hand it off cleanly.** Export a self-contained HTML file or a PDF — no broken links, no
  missing fonts, nothing to install on the other end.
- **Start from nothing.** Point it at a topic and let it build the first draft for you.

## Curious how it works?

The click-to-edit magic, the version model, and why edits never corrupt your document are all
explained in **[HOW_IT_WORKS.md](HOW_IT_WORKS.md)** — written for the curious, not required for
the user. The full design record lives in [`docs/adr/`](docs/adr/) (17 architecture
decisions) and the approved spec in [`docs/requirements.md`](docs/requirements.md).

## License

MIT — see [LICENSE](LICENSE).
