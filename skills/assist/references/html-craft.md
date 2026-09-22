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
`--print-to-pdf`** (not a browser screenshot). The exporter injects print rules
into the PDF-prep copy only (`src/service/export.js`) — **the HTML download is
your document as authored, no print injection**. Every PDF gets a render-safety
baseline (animations off, reveal patterns completed, `print-color-adjust:exact`);
the 16:9 landscape `@page` + one-slide-per-page rules are added **only when the
doc DECLARES itself a deck**. Plain semantic `<section>`s never do — the web, doc
and brochure formats are built from sections. Author so the rules apply as intended:

- **Declare a deck.** A slide is `<section class="wi-slide">` (formats/ppt.md),
  `.slide`, or `[data-slide]`; 2+ of them at the top of the body, or inside ONE
  wrapper, make the doc a deck. Deeper than that (e.g. `<main>` > `<div>` >
  slides, or a carousel inside a page) is a component, not a deck — declare it
  explicitly instead: `data-wi-kind="deck"` on a wrapper element around the
  slides (not on `<html>`/`<body>` — the version store keeps body content only),
  or create the doc with `style: "ppt"`. Only a declared deck gets the exporter's
  `@page { size: 13.333in 7.5in; margin: 0 }` and one-slide-per-page pagination.
- **Only `@page` pins the paper.** If you declare `@page { size: … }` (a print
  brochure, an A4 report), the exporter never changes the paper — the PDF is what
  Chrome prints of your HTML. `.page`/`.wi-page` wrappers or `break-after: page`
  alone do NOT pin a size: they only stop the exporter from forcing one slide per
  page (your breaks are kept; a declared deck without `@page` still gets the 16:9
  paper). Declare the size you mean.
- **An explicit deck keeps its slides on your paper.** `style: "ppt"` or
  `data-wi-kind="deck"` plus your own `@page { size: A4 landscape }` gives one
  slide per A4-landscape page; a weak `.slide` marker plus `@page` is a document
  (the paper is yours, no slide pagination).
- **The `.html` download prints as authored.** No print rules are injected into
  it — if your deck must print standalone from a browser, write your own
  `@media print` rules (reveal patterns completed, `print-color-adjust: exact`).
- **Screen-scope responsive rules.** `--print-to-pdf` lays out at a narrow width,
  so a bare `@media (max-width: N)` FIRES during the PDF render and collapses your
  grids. Always scope phone/tablet rules `@media screen and (max-width: N) { … }`,
  and pin multi-column grids inside `@media print` if they must stay columned.
- **Don't rely on gradient-clipped text for meaning in a deck.** In a DECK the
  exporter paints `-webkit-background-clip:text` runs solid (the slide contract);
  if a heading/number must be a specific color in print, set a solid `color` too.
- **Backgrounds and fills survive** via `print-color-adjust:exact` (injected on
  `*`), so dark slide backgrounds and gradient FILLS on real elements render. In a
  DECK, `box-shadow`/`text-shadow` are stripped in print, so don't depend on a glow
  to convey state; a document prints its shadows and gradient text as authored.
- **One idea per slide, fits one screen.** Declared deck slides are forced to `100vh`
  with `overflow:hidden`; content that overflows a slide is clipped, not paginated —
  split it into another slide.

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
