# Design principles — make it look genuinely designed, not just themed

The theme (`src/themes/*.json`) gives every draft a competent baseline for free (see
html-craft.md). This file is the next layer: the visual judgment that separates a *themed* deck
from a *designed* one. None of it is pixel math — these are HTML/CSS decisions you make while
authoring. When a choice here conflicts with the theme, prefer the theme's tokens
(`var(--wi-primary)`, `var(--wi-font-heading)`, …) so a theme switch still flows through; reach
for an override only where a block genuinely earns it.

## Color — restraint reads as quality

- **Five colors, max.** A deck is a primary, a secondary, an accent, and one or two neutrals. As
  a working convention, count only *chromatic* colors — pure grayscale (text, borders, backgrounds
  where R=G=B) doesn't count toward the five. More than that and the deck looks chaotic before a
  word is read.
- **Weight ~60 / ~30 / ≤10.** One color dominates (~60% of the colored area — usually the
  background or the largest surface), a supporting color carries ~30%, and the accent appears in
  **≤10%**. The accent is the one thing the eye should land on per slide — a key number, the CTA,
  one highlighted run. Spend it sparingly or it stops meaning "look here."
- **Don't invent a color per slide.** Every color on every slide belongs to the established
  palette. Section dividers may flip to a dark background, but text and accent adapt predictably —
  don't alternate accents slide to slide unless they're semantically coded (e.g. a data series).
- **Contrast is non-negotiable (WCAG AA).** Body text ≥ 4.5:1 against its background; large text
  (≥ 24px, or ≥ 18.7px / 14pt bold) ≥ 3:1; meaningful icons/borders ≥ 3:1. On a **dark background,
  judge the composited color** — a translucent fill like `rgba(161,0,255,.06)` over `#0D0117`
  resolves to nearly the background, so check the *blended* result, not the raw rgba. Aim for 7:1
  on dark for comfortable reading. (Remember: print strips shadows and neutralizes gradient-clipped
  text — html-craft.md's PDF contract — so never rely on a glow or a gradient for legibility.)

## Typography — two fonts, a clear ladder

- **At most two families** — a heading face and a body face (`--wi-font-heading` / `--wi-font-body`).
  If only one is available, differentiate heading from body by **weight and size**, never by adding
  a third font for captions.
- **A visible size ladder, ≤ 4 sizes per slide.** Title is clearly the largest; section/subhead
  next; body uniform; caption smallest. If you need more gradation, change weight or color, not
  size. The test: cover the body and read only the title — if the slide's point survives, the
  hierarchy is right.
- **Line-height for breathing room** — ~1.2 for headings, 1.3–1.4 for body, 1.4–1.5 for lists so
  items don't run together. Don't set body below ~16px-equivalent; it stops being comfortable at
  presentation/reading distance.
- **Left-align body, never justify** (justification opens ragged rivers at display sizes). Centered
  titles and short pull quotes are fine; centered multi-line body is hard to scan. A little
  letter-spacing helps all-caps labels; leave body tracking at default.

## Layout — whitespace and a low element count

- **Keep ~30% of each slide empty.** Whitespace isn't wasted — it directs the eye and makes what's
  present land. If a slide drops below that, cut content or split it in two.
- **≤ 6–7 top-level elements per slide.** A "top-level element" is any independently placed block
  (heading, body, card, image, accent shape). Group related items so the *perceived* count stays
  low, and remove decoration before adding content — a thin rule still counts.
- **One idea per slide.** The heading is the takeaway ("Revenue grew 18%"), not a label
  ("Revenue"). Everything else supports that one idea; two ideas are two slides (outline-method.md).
- **Lead the eye.** Headline-plus-visual-plus-CTA slides read on a **Z** (top-left → top-right →
  down → bottom-right); text-and-bullets slides read on an **F**. Put the most important element
  where the scan starts — the upper-left — and attribution/footnotes where it ends.

## Hierarchy — size, then color, then position

Three levers create visual weight, in order of force: **size** (biggest = most important — the
title should be the largest text), **color** (the accent draws the eye — spend it on the one thing
that matters), **position** (upper-left is heaviest). Make all three point the same way. A large
block in the dead corner fighting a small accent up top just reads as confusion.

## Cards, shapes, and accents

- **One shape language.** If cards are rounded, accent bars and dividers are rounded too; if the
  language is sharp, keep it sharp throughout. Mixing rounded and hard corners reads as amateur.
- **Cards** (`<div data-card>` — html-craft.md) inherit the theme's surface, radius, and padding.
  Keep the radius consistent across a slide. Shadows should be soft and subtle on screen, but
  don't *depend* on them — they're stripped in PDF.
- **Accent bars** — a 2–4px bar on the left edge of a quote, callout, or key takeaway, in the
  primary or accent color, is a cheap, high-class way to add structure. Reserve it for emphasis;
  on every block it's noise.

## Where this sits

Structure first (outline-method.md), then narrative (story-arc.md), then *this* (visual design),
then implement export-safe (html-craft.md), then self-check before you hand it back
(quality-checklist.md). Surface polish can't rescue a broken structure — but a sound structure
rendered without these is the difference between "fine" and "they'll trust this."
