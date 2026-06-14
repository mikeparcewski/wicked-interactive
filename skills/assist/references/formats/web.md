# Format: Web

A web document is a **rich, scrollable, interactive HTML experience** — the flagship format.
Vivid layouts, scroll-driven animations, interactive elements, and a strong visual identity.
This is the format where full creative range is appropriate. Export to PDF is supported but
secondary — design for the screen first.

## Structure

A web doc is a continuous scrolling page built from thematic `<section>` blocks:

```html
<div class="wi-web">
  <section class="wi-section wi-section--hero">…</section>
  <section class="wi-section wi-section--content">…</section>
  <section class="wi-section wi-section--cta">…</section>
</div>
```

Each `<section>` is a thematic zone. There's no fixed height — sections grow with content.
The hero section should fill or nearly fill the viewport (`min-height: 100vh`).

## Section patterns

| Pattern | CSS modifier | Use for |
|---|---|---|
| **Hero** | `--hero` | Opening: full-bleed, bold type, strong visual |
| **Feature** | `--feature` | Key capability or product highlight |
| **Stats** | `--stats` | Numbers, social proof, KPIs |
| **Content** | `--content` | Narrative prose, detailed explanation |
| **Cards** | `--cards` | Grid of 3–4 equal items |
| **Quote** | `--quote` | Full-width pull quote, centered |
| **CTA** | `--cta` | Closing call-to-action |
| **Dark alternating** | `--dark` on alternating sections | Visual rhythm; don't do every section |

## Typography — scale with screen

Use `clamp()` for all type so it scales gracefully:

- **Hero h1**: `clamp(48px, 7vw, 96px)`, bold, short (≤ 6 words)
- **Section h2**: `clamp(28px, 3.5vw, 52px)`, semibold
- **Subheading h3**: `clamp(18px, 2vw, 26px)`, medium
- **Body**: `clamp(15px, 1.2vw, 18px)`, line-height `1.75`, max-width `64ch`
- **Large callout**: `clamp(22px, 3vw, 44px)`, medium or light weight — for pull quotes

Use the theme's font tokens (`var(--wi-font-heading)`, `var(--wi-font-body)`) — don't hardcode
font families.

## Animations (use, don't abuse)

Animations signal interactivity and quality. Rules:
- **Entrance animations only** — elements fade/slide in as they enter the viewport
- **CSS only** — `@keyframes` + `IntersectionObserver` or CSS `:is(:hover, :focus)` triggers
- **Duration 200ms–600ms**; ease-out for entrances, ease-in-out for hovers
- **Max one animation type per element** — don't stack fade + slide + scale simultaneously
- **Respect `prefers-reduced-motion`** — wrap all animations:
  ```css
  @media (prefers-reduced-motion: no-preference) { .wi-animate { animation: … } }
  ```
- **No continuous loops** (spinning, pulsing) except small accent indicators (a dot, a badge)

## Interactive elements

- **Tabs / accordions** — fine; use semantic `<button>` for toggles, `aria-expanded`
- **Hover cards** — cards that lift on hover with `box-shadow` + `transform: translateY(-2px)`
- **Scroll-linked effects** — subtle parallax on hero bg is acceptable; full-page scroll-jacking is not
- **No modals** — the click-to-edit feedback loop already uses an overlay; don't compete with it

## Layout

- CSS Grid for section internals: `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`
- `gap: clamp(16px, 3vw, 40px)` for consistent spacing
- Full-bleed sections: `width: 100%`, no max-width on the section itself; constrain content with an inner `.wi-wrap { max-width: 1200px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 48px); }`

## Visual elements

- **Full-bleed backgrounds**: solid color, subtle gradient, or very low-opacity texture
- **Hero background**: deep color or image (`background-size: cover`) with an overlay for legibility
- **Cards** (`data-card`): consistent padding via theme tokens, `border-radius: var(--wi-radius-card)`, subtle shadow
- **SVG icons**: inline, ≤ 40px decorative, ≤ 24px inline with text
- **No raster images unless provided by the user** — use CSS shapes, SVG, or emoji as placeholders

## Quality gate (run before emitting)

- [ ] Hero section fills ≥ 90vh on desktop
- [ ] `prefers-reduced-motion` wraps all `@keyframes` and transitions
- [ ] All interactive controls use `<button>` or `<a>` — no `div` click handlers
- [ ] Body text `≥ 15px`, line-height `≥ 1.65`, max-width `≤ 70ch`
- [ ] No `position: fixed` elements (conflicts with the editor overlay)
- [ ] Section count reasonable: 4–10 sections for most docs
- [ ] Dark sections use high-contrast text (WCAG AA minimum)
- [ ] Cards use `data-card` attribute so theme and editor recognise them
