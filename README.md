```
           _      _            _       _       _                      _   _           
 __      _(_) ___| | _____  __| |     (_)_ __ | |_ ___ _ __ __ _  ___| |_(_)_   _____ 
 \ \ /\ / / |/ __| |/ / _ \/ _` |_____| | '_ \| __/ _ \ '__/ _` |/ __| __| \ \ / / _ \
  \ V  V /| | (__|   <  __/ (_| |_____| | | | | ||  __/ | | (_| | (__| |_| |\ V /  __/
   \_/\_/ |_|\___|_|\_\___|\__,_|     |_|_| |_|\__\___|_|  \__,_|\___|\__|_| \_/ \___|
```

# wicked-interactive

### Make the decks, docs, marketing pages, and demo videos you have to ship — just by describing them.

You know how Replit lets you build an app by just *talking* to it? This is that — for the
board deck due Monday, the launch one-pager, the sales landing page, the walkthrough video of
your product. **Describe what you need and it builds it, live in your browser.** Then point at
anything you want to change, say it, and watch it update. No code. No design tickets. No "let
me loop in the team." Just you, a running Claude, and the thing you actually have to deliver.

```
Describe it  →  Watch it build  →  Point at what to change  →  Ship it (HTML · PDF · video)
```

It's powered by your Claude Code plan. If you can describe it, you can build it.

---

## What you can make

- 📊 **Presentations & decks** — board updates, pitch decks, QBRs. Themed, on-brand, export-ready.
- 📄 **Documents & one-pagers** — reports, briefs, proposals, FAQs.
- 📣 **Marketing materials** — landing pages, launch announcements, sales one-pagers, anything web.
- 🎬 **Demo videos of your app** — point it at a running app, say what to show, and get a narrated walkthrough with clickable chapter thumbnails.

It's all interactive HTML under the hood — built, refined, and exported entirely in your browser.

## Try it in 30 seconds

> *"Build me a deck about our Q3 results from scratch."*
> *"Make a landing page for the new pricing tier."*
> *"Record a walkthrough of my app showing sign-up and the dashboard."*
> *"Write a one-pager pitching the migration to the leadership team."*
> *"Make this headline punchier — and that number's $4.2M, not $4M."*
> *"Make the whole thing feel premium."*

Describe what you want and it builds a first draft. Then click any block, say what to change,
and it happens — live, in front of you. Every version is saved automatically, so you can
rewind to any draft, or **fork** and chase two ideas at once. When it's ready, export a clean
HTML file or PDF — or download your demo video. Done.

## Why people actually like it

- 🪄 **You make it by describing it.** Decks, docs, pages, videos — start from a topic, get a real first draft.
- 🖱️ **You refine by pointing.** Highlight anything, say what you want in normal words.
- 📎 **Bring your own facts.** Attach files and folders; it reads them so your real numbers and decisions show up.
- 🎬 **Turn your app into a video.** A narrated walkthrough with YouTube-style chapter thumbnails — re-record just by asking.
- ⏪ **You can't lose work.** Every change is a new saved version. Rewind anytime.
- 🍴 **Try both directions.** Fork from any version and keep them side by side.
- 📤 **Send it anywhere.** Export self-contained HTML or PDF, or download the video — nothing to install on their end.
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
