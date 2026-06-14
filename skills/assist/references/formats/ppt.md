# Format: PPT (Slide Deck)

A PPT-style document targets **PPTX export** — fixed 16:9 landscape slides, clean layout,
zero animations. The service exports it via LibreOffice Impress, which converts the HTML
slides to native `.pptx`. Everything here keeps the export clean and editable.

## Slide anatomy

One `<section>` = one slide. The slide must be exactly 16:9 and overflow-free:

```html
<section class="wi-slide">
  <div class="wi-slide__body">
    …content…
  </div>
</section>
```

Target **8–16 slides**. Fewer than 8 feels thin; more than 20 loses the room.

## Slide layouts (use these — don't invent new ones)

| Layout class | Structure | Use for |
|---|---|---|
| `wi-slide--title` | Centered h1 + subtitle, full-bleed bg | Opening, closing, section dividers |
| `wi-slide--content` | h2 top-left, bullet body below | Standard content slide |
| `wi-slide--two-col` | h2 top, two equal columns below | Comparison, before/after |
| `wi-slide--big-stat` | One giant number + label, centered | KPI, milestone |
| `wi-slide--quote` | Pull-quote centered, attribution below | Testimonial, key insight |
| `wi-slide--image-right` | Copy left 60%, image right 40% | Case study, product shot |

Never put more than **one layout pattern per slide**.

## Typography — keep it large, keep it sparse

- **Slide title (h2)**: `28px–36px`, bold, ≤ 8 words
- **Bullet body**: `18px–22px`, line-height `1.5`, ≤ 5 bullets per slide, ≤ 12 words each
- **Big stat**: `clamp(64px, 10vw, 120px)`, bold
- **Caption / label**: `12px–14px`, muted color

One font size rule: **if a slide has bullets, the bullets are all the same size**. Don't vary
body type size within a slide — it breaks the export grid.

## Animation and interactivity: zero

The PPTX exporter renders slides as static HTML → static slide snapshots.

- **No CSS animations** — `@keyframes`, `transition`, `animation` all disappear in export
- **No JavaScript interactions** — click handlers, scroll effects, IntersectionObserver: gone
- **No `position: fixed`** — fixed elements don't translate to slide coordinates
- **No `overflow: auto/scroll`** — slides are static; scrollable regions just clip

If a design decision requires animation to make sense (e.g., step-by-step reveal), convert it
to a sequence of separate slides instead.

## Export-safe CSS patterns

```css
/* Good: static, simple, survives Impress */
.wi-slide { width: 100%; aspect-ratio: 16/9; overflow: hidden; position: relative; }
.wi-slide__body { padding: 48px 56px; height: 100%; display: flex; flex-direction: column; gap: 24px; }

/* Avoid: these silently break or vanish in PPTX */
/* backdrop-filter, mix-blend-mode, clip-path, transform: rotate */
/* CSS grid with fr units (use flex or fixed px instead) */
/* SVG filters (drop-shadow via filter: drop-shadow()) */
```

Use `box-shadow` sparingly — it renders in export but can look heavy. Prefer `border`.

## Content discipline

- **One idea per slide** — if you need a second point, add a slide
- **Bullets are fragments**, not sentences. Bad: "We achieved a 30% reduction in cost."
  Good: "30% cost reduction — Year 1"
- **Numbers beat adjectives** — "3× faster" beats "significantly faster"
- **Speaker notes** → omit (not rendered). The slide must stand alone.

## Quality gate (run before emitting)

- [ ] Every slide is 16:9 and overflow-free
- [ ] No `animation`, `transition`, or `@keyframes`
- [ ] No JavaScript event listeners
- [ ] No `position: fixed`
- [ ] ≤ 5 bullets per content slide, ≤ 12 words each
- [ ] Opening title slide + closing slide present
- [ ] 8–16 slides total
- [ ] All layout classes from the approved set above
