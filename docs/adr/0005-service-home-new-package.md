# ADR-0005: Service home — a new `wicked-interactive` package

## Status
Accepted — 2026-05-26 (product-owner selection)

## Context
A long-running local service owns file-watch, regeneration, SSE push, and export. It
must reuse wicked-prezzie's render/extract/theme/PDF primitives. Where should it live?

## Options Considered
- **(a) New `wicked-interactive` package depending on wicked-prezzie as a library —
  CHOSEN.**
- (b) A `serve` mode added to the existing wicked-prezzie plugin — rejected: couples the
  interactive feedback loop into prezzie's surface area.
- (c) A repo-local launcher only, not yet packaged — rejected: defers packaging and
  weakens the reuse story.

## Decision
Create a new `wicked-interactive` package/plugin exposing a `serve` command. It depends
on **wicked-prezzie as a library** (render / Chrome-headless extract / theme / HTML→PDF)
— never via subprocess. One-shot skills: `serve` (start), `build` (generate +
instrument), `export`. The business user runs the single start command; everything else
happens in the browser (INV-6).

## Consequences
- Clean separation of concerns: prezzie stays a rendering substrate; the interactive
  loop is its own product with independent versioning and lifecycle.
- Requires new package scaffolding and a dependency on prezzie's **library API**, which
  must therefore be import-stable (a coordination obligation on prezzie).

## Trade-offs Accepted
One additional package to maintain vs folding into a single plugin.
