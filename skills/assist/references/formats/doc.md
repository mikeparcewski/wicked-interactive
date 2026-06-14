# Format: Doc

A doc is a **content-first, readable document** — like a well-structured Word or Google Doc.
Minimal visual chrome, strong typographic hierarchy, easy to read on screen and to print.
No slide containers, no hero sections, no decorative backgrounds. The content is the design.

## Structure

A doc is a single scrollable page — no `<section>` slides, no fixed-height containers:

```html
<article class="wi-doc-body">
  <header class="wi-doc-header">
    <h1>Document Title</h1>
    <p class="wi-doc-meta">Author · Date · Optional tagline</p>
  </header>

  <section class="wi-doc-section">
    <h2>Section Heading</h2>
    <p>Body copy…</p>
  </section>
</article>
```

Use `<h1>` once (the document title). Use `<h2>` for major sections, `<h3>` for subsections.
Never skip levels.

## Typography

- **Title (h1)**: `clamp(28px, 3.5vw, 48px)`, bold or semibold
- **Section heading (h2)**: `22px–28px`, semibold, `margin-top: 2em`
- **Subsection (h3)**: `18px–20px`, medium weight
- **Body**: `16px–18px`, line-height `1.75`, max-width `68ch` — readability first
- **Caption / note**: `13px–14px`, muted color

All body text in one size. Hierarchy comes from heading levels, not font-size variation in body.

## Layout

- **Single column** is the default. Max-width `760px`, centered.
- **Two-column** only for reference material (glossary, comparison tables, specs). Never for narrative prose.
- **No sidebar**. No sticky headers. No floating elements.
- Generous whitespace: `margin-top: 2em–3em` before `<h2>`, `1em` between paragraphs.

## Allowed visual elements

- **Block quote** (`<blockquote>`) — left border accent, indented, for pull quotes or citations
- **Call-out box** — `<div data-card>` with a subtle background (`var(--wi-surface-2)`) for tips, warnings, or key points
- **Horizontal rule** (`<hr>`) — thin, muted, for major section breaks only
- **Inline code** (`<code>`) and **code blocks** (`<pre><code>`) — monospace, themed
- **Tables** — fine in docs; use `<thead>`, `<tbody>`, keep columns ≤ 5
- **Ordered and unordered lists** — standard; body font size, standard list-style

## What doesn't belong in a doc

- Hero sections with full-bleed backgrounds
- Big stat layouts or card grids (use `<table>` or a simple list instead)
- CSS animations or transitions
- Fixed-height containers of any kind
- Background images or textures

## Tone and voice

A doc is read, not scanned. Write full sentences. Headings can be noun phrases or questions
("Why this matters", "How it works") — they don't need to be fragment keywords.
Paragraphs should be 3–6 sentences. Short doesn't mean telegraphic.

## CSS baseline

```css
.wi-doc-body {
  max-width: 760px;
  margin: 0 auto;
  padding: clamp(24px, 4vw, 64px) clamp(16px, 3vw, 32px);
  font-size: clamp(16px, 1.2vw, 18px);
  line-height: 1.75;
  color: var(--wi-ink);
}
.wi-doc-header { margin-bottom: 3em; border-bottom: 1px solid var(--wi-line); padding-bottom: 2em; }
.wi-doc-section + .wi-doc-section { margin-top: 3em; }
```

## Quality gate (run before emitting)

- [ ] Single `<h1>` (document title only)
- [ ] Body text at `16px+`, line-height `1.7+`, max-width `≤ 70ch`
- [ ] No fixed-height containers
- [ ] No animations or transitions
- [ ] No hero / full-bleed decorative sections
- [ ] Heading hierarchy respected (h1 → h2 → h3, no skips)
- [ ] Tables (if any) have `<thead>` + `<tbody>` and ≤ 5 columns
