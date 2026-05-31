```
           _      _            _       _       _                      _   _           
 __      _(_) ___| | _____  __| |     (_)_ __ | |_ ___ _ __ __ _  ___| |_(_)_   _____ 
 \ \ /\ / / |/ __| |/ / _ \/ _` |_____| | '_ \| __/ _ \ '__/ _` |/ __| __| \ \ / / _ \
  \ V  V /| | (__|   <  __/ (_| |_____| | | | | ||  __/ | | (_| | (__| |_| |\ V /  __/
   \_/\_/ |_|\___|_|\_\___|\__,_|     |_|_| |_|\__\___|_|  \__,_|\___|\__|_| \_/ \___|
```

## It's 11pm. The deck's due tomorrow. You haven't opened PowerPoint.

Good news: you don't have to. Just tell it what you need — out loud, like you'd tell a coworker — and watch it build the thing in your browser. The board deck. The launch one-pager. The sales page. A narrated demo video of your product. Then point at anything you don't like and say what to fix.

No code. No design tickets. No "let me loop in the team." Just you, describing what's in your head, watching it appear.

```
Describe it  →  Watch it build  →  Point at what to change  →  Ship it (HTML · PDF · video)
```

If you can say it, you can make it.

<p align="center">
  <img src="https://raw.githubusercontent.com/mikeparcewski/wicked-interactive/main/assets/wicked-interactive-demo.gif" alt="wicked-interactive in action: describe a launch page in chat, watch it build live, point at text to change it, remove a block, ask to make it premium, and rewind any version — all in the browser" width="100%">
</p>

---

## Stuff you'd normally dread making

- 📊 **Decks** — board updates, pitch decks, QBRs. On-brand and export-ready, not a sad bulleted list.
- 📄 **Docs & one-pagers** — reports, briefs, proposals, the FAQ nobody wants to write.
- 📣 **Marketing** — landing pages, launch posts, sales pages, anything that lives on the web.
- 🎬 **Demo videos** — point it at your live app, say what to show, get a narrated walkthrough with clickable chapter thumbnails.

Under the hood it's all real, interactive HTML — built, polished, and exported without you ever leaving the browser.

## Try it in 30 seconds

Talk to it like this:

> *"Build me a deck about our Q3 results from scratch."*
> *"Make a landing page for the new pricing tier."*
> *"Record a walkthrough of my app showing sign-up and the dashboard."*
> *"Make this headline punchier — and that number's $4.2M, not $4M."*
> *"Honestly? Make the whole thing feel more expensive."*

It hands you a first draft. You click a thing, say what's wrong, and watch it fix itself — live, while you're looking at it. Every version quietly saves, so you can rewind to that one you liked three changes ago — or **fork** it and chase two ideas at once without losing either. When it looks right, export clean HTML or PDF, or grab the video. Done. Go to bed.

## Why people get hooked

- 🪄 **Just start talking.** Give it a topic, get a real first draft back. No blank page, ever.
- 🖱️ **Fix it by pointing.** See something off? Highlight it, say what you want in plain English, done.
- 📎 **It uses your actual numbers.** Drop in your files and folders; it reads them so the real figures show up — no copy-paste.
- 🎬 **Your app becomes a video.** Narrated walkthrough with YouTube-style chapters. Want a different take? Just ask again.
- ⏪ **You literally cannot lose work.** Every change is a saved version. Rewind to any of them, anytime.
- 🍴 **Can't decide? Don't.** Fork any version and keep both, side by side.
- 📤 **Send it to anyone.** One self-contained file — HTML, PDF, or video. Nothing for them to download or figure out.
- 🙅 **No scary black terminal.** Once it's going, it all happens in your browser.

## Get it running

First, a one-time bit of setup. You'll need [Claude Code](https://claude.com/claude-code) — install it, then paste these two lines where it asks:

```
/plugin marketplace add mikeparcewski/wicked-interactive
/plugin install wicked-interactive
```

And from then on, the only thing you ever type is:

> **"start wicked-interactive"**

That's genuinely it. The first time, it sets up a few helper tools behind the scenes — it'll show you exactly what it's installing, nothing sneaky — then your browser pops open and you're off. (Rather install the helpers yourself? Set `WI_NO_AUTOINSTALL=1` and it'll just tell you what to run.)

---

MIT licensed — see [LICENSE](LICENSE). Built on [wicked-prezzie](https://github.com/mikeparcewski/wicked-prezzie), [wicked-garden](https://github.com/mikeparcewski/wicked-garden), and [wicked-brain](https://github.com/mikeparcewski/wicked-brain).
