# HTML craft — generate documents that stay clickable, themeable, exportable

The draft you emit (`wicked.interactive.draft.completed`) is instrumented (fresh `data-wid` per block),
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

## PDF export contract — author print-safe decks by construction

Export to PDF renders the self-contained HTML through **headless Chrome
`--print-to-pdf`** (not a browser screenshot). The exporter auto-injects a print
stylesheet (`src/service/export.js`): a universally-safe baseline for every doc,
plus 16:9 landscape `@page` + one-slide-per-page rules **only when the doc is a
deck** (detected as **2+ top-level slide containers** — `<section>`,
`[data-slide]`, or `.slide`). A one-pager with a single `<section>` and a long
article stay in their natural flow. Author so that injection is enough:

- **A deck is multiple `<section>`s** — one per slide. That is what triggers the
  landscape `@page { size: 13.333in 7.5in; margin: 0 }` and one-slide-per-page
  pagination. A single `<section>` reads as a one-pager and is left in portrait
  flow, so don't wrap a real multi-slide deck in one giant `<section>`.
- **Screen-scope responsive rules.** `--print-to-pdf` lays out at a narrow width,
  so a bare `@media (max-width: N)` FIRES during the PDF render and collapses your
  grids. Always scope phone/tablet rules `@media screen and (max-width: N) { … }`,
  and pin multi-column grids inside `@media print` if they must stay columned.
- **Don't rely on gradient-clipped text for meaning.** `background:linear-gradient`
  + `-webkit-background-clip:text` + transparent fill paints a solid box in PDF;
  the exporter neutralizes it to a solid color. If a heading/number must be a
  specific color in print, set a solid `color` too, not only the gradient.
- **Backgrounds and fills survive** via `print-color-adjust:exact` (injected on
  `*`), so dark slide backgrounds and gradient FILLS on real elements render. But
  `box-shadow`/`text-shadow` are stripped in print (they print as hard rectangles),
  so don't depend on a glow to convey state.
- **One idea per slide, fits one screen.** Deck slides are forced to `100vh` with
  `overflow:hidden`; content that overflows a slide is clipped, not paginated —
  split it into another `<section>`.

**Verification note (load-bearing):** reproduce any PDF-export issue with the REAL
`chromeRenderer` `--print-to-pdf` command (e.g. call `exportPdf`/`exportHtml`), NOT
Playwright `page.pdf({ preferCSSPageSize, printBackground })` — Playwright produces
different output (it honors flags `--print-to-pdf` ignores and vice-versa), so a fix
that looks right under Playwright can still be broken in the real export.

## Common smells to avoid

- A wall of text in one `<p>` — split into blocks so each is clickable.
- Decorative `<div>` soup with no semantic elements — nothing for the user to click-edit.
- Hardcoded colors that ignore the theme — looks off the moment the user switches themes.
- Two messages crammed on one slide — split them (see outline-method.md).
