# Quality checklist — run this before you hand a draft back

Before you emit `wicked.draft.completed` (a first draft or whole-doc change) or
`wicked.edit.completed` (a structural edit), self-check against this list. It's the reactive
counterpart to the other references — it catches the things that make a draft feel "off" even when
the user can't name why. **Fix structure and content before surface**; a polished render can't
rescue a weak argument or an overstuffed slide.

Severities: **FAIL** = fix before you ship it; **WARN** = fix if it's cheap; **INFO** = note it,
improve on the next pass. Don't block a user's edit on a knowledge miss or a stylistic INFO.

## Narrative (does the argument hold) — from outline-method.md / story-arc.md

- **One governing thought** the reader keeps if they read nothing else. If you can't state it in a
  sentence, it's notes, not a document. **(FAIL)**
- **Each section earns the next.** If you could shuffle the sections with no loss, the arc is weak.
  **(WARN)**
- **Every number grounded** in the source or wicked-brain — never invented to fill a slot. **(FAIL)**
- **A single ask.** A deck that asks for three things gets none. **(WARN)**
- **Right altitude** for the audience — an exec update isn't an engineering deep-dive. **(WARN)**

## Content — from the deck content rules

- **Title present, ≤ ~10 words, a takeaway not a label** ("Revenue grew 18%", not "Revenue"); no
  two slides share a title. Missing title → **FAIL**; too long / duplicate → **WARN**.
- **Bullets: ≤ 6–7 per slide, ≤ ~12 words each.** Over the hard limit → **FAIL** (split the slide
  or move detail into prose); near it → **WARN**.
- **Stats are clean and labeled** — `47%`, `$2.3M`, `12×`, not raw `1234567`; every stat has a
  short label saying what it measures. **(WARN)**
- **Quotes are attributed** — name plus role/company. No attribution → **FAIL**; partial → **WARN**.
- **CTA leads with an imperative verb** — "Schedule a demo", "Start the trial". **(INFO→WARN)**
- **Watch passive voice.** If most sentences are passive the copy feels abstract — prefer active.
  **(INFO)**

## Visual — from design-principles.md

- **≤ 5 chromatic colors, all from the palette;** no one-off color on a single slide. **(WARN,**
  FAIL if it breaks contrast).
- **≤ 2 font families, ≤ 4 sizes per slide,** a clear size ladder. **(WARN)**
- **≥ ~30% whitespace and ≤ 6–7 top-level elements** per slide — if it feels cramped, split it.
  **(WARN)**
- **Contrast meets WCAG AA** (body 4.5:1, large 3:1), judged on the *composited* color over dark
  backgrounds. A real contrast failure is a **FAIL**.
- **Nothing clipped or overflowing** its container or the slide. **(FAIL)**

## Export-safe — from html-craft.md (the PDF contract)

- **A real deck is multiple `<section>`s** (one per slide) — that's what triggers landscape
  one-slide-per-page in PDF; don't wrap a deck in one giant section. **(WARN)**
- **Responsive rules are `@media screen`-scoped,** so they don't fire and collapse grids during the
  `--print-to-pdf` render. **(FAIL** if a deck's columns collapse in PDF).
- **One idea fits one screen** — deck slides are clipped to `100vh`, not paginated, so overflow is
  lost. Split it. **(WARN)**
- **No reliance on shadows or gradient-clipped text for meaning** — both are neutralized in print.
  **(WARN)**

## The one hard rule (not stylistic)

On a structural edit, **every pre-existing `data-wid` survives** (INV-2 — Step 2). That's verified
mechanically in Step 3c, not by eye. This checklist is judgment; that one is a gate.

Keep it proportional: a quick chat tweak doesn't need the full sweep, but any first draft or
whole-document change should pass the narrative and content sections before you emit it.
