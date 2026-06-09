# HTML craft — generate documents that stay clickable, themeable, exportable

The draft you emit (`wicked.draft.completed`) is instrumented (fresh `data-wid` per block),
themed, and landed as a version. Write HTML that plays well with all three.

## Structure for instrumentation

The instrumenter anchors reviewable blocks (headings, paragraphs, list items, cards) so the
user can click any one to edit it. Help it:

- **Use semantic block elements** — `<section>`, `<h1>`–`<h3>`, `<p>`, `<ul><li>`, and cards as
  `<div data-card>`. Each becomes a clickable, individually-editable unit.
- **One slide/section per `<section>`.** For a deck, each `<section>` is a slide; the editor
  and export treat them as units.
- **Don't hand-write `data-wid`** — the service assigns them. Just write clean, well-nested
  markup; malformed/unbalanced tags break anchoring.
- **Mark cards** with `data-card` so the theme's card styling (background, radius, shadow,
  padding) applies and the block is recognised as a unit.

## Theme, don't hardcode

A base theme (`src/themes/*.json`) is injected as element-level CSS variables, so:

- **Lean on the theme.** Plain semantic HTML inherits the product look automatically — heading
  font, body font, primary/accent colors, card treatment. A draft with *no* inline styling
  still looks designed.
- **Override sparingly, with classes/inline styles**, only where a block genuinely differs. Your
  inline styles win over the base layer (it's lowest precedence), so a one-off accent is fine —
  but don't restyle everything, or you fight the theme and lose consistency across versions.
- **Use the CSS variables** when you do style: `var(--wi-primary)`, `var(--wi-accent)`,
  `var(--wi-font-heading)`, `var(--wi-card-bg)`, etc., so a theme switch still flows through.

## Export-clean

Exports inline everything for a single self-contained file (HTML/PDF). So:

- **Prefer inline SVG and data-URI or absolute https images** over local file paths the export
  can't resolve. (See image sourcing below.)
- **No external runtime JS** for core content — the document must render correctly as static
  HTML opened straight from disk. Interactivity that matters should survive without a server.
- **Avoid web-font CDNs** for anything load-bearing; the theme's font stack uses system/Office
  fonts so the export matches what the user saw.

## Image sourcing

- **Real assets the user gave you** (from attached sources) win — use their actual charts/logos.
- **Stock**: a relevant Unsplash image by URL is fine for a hero/background; pick by subject,
  not decoration, and keep it subordinate to the message.
- **Diagrams**: prefer inline SVG you author over a raster — it scales, themes, and exports
  crisply. A simple flow/box diagram in SVG beats a fuzzy screenshot.
- **Never** hotlink something that needs auth or will rot; if it must persist, it must be
  inlinable.

## Common smells to avoid

- A wall of text in one `<p>` — split into blocks so each is clickable.
- Decorative `<div>` soup with no semantic elements — nothing for the user to click-edit.
- Hardcoded colors that ignore the theme — looks off the moment the user switches themes.
- Two messages crammed on one slide — split them (see outline-method.md).
