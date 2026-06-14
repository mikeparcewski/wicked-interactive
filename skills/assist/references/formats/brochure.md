# Format: Brochure

A brochure is a **landscape, print-ready marketing document** — visually rich, agency-quality,
self-contained. The viewer renders it inline; it exports as a 16:9 or A4-landscape PDF.
Every decision here optimises for "looks like it came from a design studio."

## Page anatomy

Structure as **fixed-height landscape pages** — each `<section>` is one page:

```html
<section class="wi-page">           <!-- one page per section -->
  <div class="wi-page__grid">       <!-- the layout grid for this page -->
    …content…
  </div>
</section>
```

Each page must fit without scrolling. Never rely on overflow — if content spills, cut it.
Aim for 4–8 pages total; tighter is better than padded.

## Layout patterns (pick one per page, don't mix on the same page)

| Pattern | When |
|---------|------|
| **Full-bleed hero** — image/color fills the page, centered type over it | Cover, opener, chapter divider |
| **50/50 split** — left column copy, right column visual (or reversed) | Key message + supporting visual |
| **Big stat** — one number dominates (~80% of page height), label below | KPI, milestone, single-point proof |
| **3-column grid** — equal cards or facts | Feature lists, team, services |
| **Text-heavy** — 2-column body copy with a strong headline | Case study, narrative, background |

## Typography rules

- **Heading**: large (`clamp(36px, 5vw, 72px)`), bold or black weight, short (≤ 8 words)
- **Subheading**: medium (`18px–24px`), medium weight — no more than one per page alongside a heading
- **Body**: `14px–16px`, line-height `1.65`, max-width `56ch` per column
- **Callout / pull-quote**: `clamp(22px, 3vw, 42px)`, italic or display weight — use sparingly (max 1 per page)
- Use at most **2 type sizes per page**. More reads as chaotic.

## Color discipline

- Follow `design-principles.md` — 60/30/10 rule strictly
- Each page has **one dominant surface color** (background). Don't mix background colors within a page.
- Accent color appears on at most one element per page (a number, a CTA label, a rule)
- Dark pages (dark bg, light text) and light pages (light bg, dark text) can alternate for rhythm — but don't do it every page

## Visual elements

- **Dividers / rules** — 1px or 2px, same color as accent or muted; never decorative gradients on rules
- **Icons** — inline SVG only; no raster icons; keep them ≤ 32px in body, ≤ 48px as standalone accents
- **Background textures / grids** — subtle CSS (`background-image: linear-gradient(...)`) at ≤ 4% opacity; never distracting
- **Full-bleed color blocks** — use `background: var(--wi-primary)` sections for visual rhythm; ensure `color: #fff` (or high-contrast token) on dark surfaces

## What never goes in a brochure

- Scrolling within a page
- Animations or transitions (export-unsafe)
- Tables (use cards or stat grids instead)
- Long paragraphs (> 5 lines) — edit ruthlessly before generating
- More than 3 fonts (heading + body + mono if needed)

## CSS baseline for a page

```css
.wi-page {
  width: 100%;
  aspect-ratio: 16 / 9;        /* landscape */
  overflow: hidden;
  display: flex;
  align-items: stretch;
  page-break-after: always;
  break-after: page;
}
.wi-page__grid {
  flex: 1;
  display: grid;
  padding: clamp(32px, 4vw, 64px);
}
```

## Quality gate (run before emitting)

- [ ] Every page fits in 16:9 — no overflow
- [ ] No scrollable content within a page
- [ ] No more than 2 type sizes per page
- [ ] Accent color used ≤ 1× per page
- [ ] 4–8 pages total
- [ ] No animations, no transitions
- [ ] All `data-card` blocks have consistent padding via theme tokens
