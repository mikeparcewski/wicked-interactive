# ADR-0011: Section & theme-level editing

## Status
Accepted — 2026-05-27 (lifts a v1 non-goal after dogfooding)

## Context
v1 anchors only text/image blocks (ADR-0001), so feedback can only target those. Dogfooding
surfaced the gap immediately: a user gave the feedback **"too dark"** on the hero, but the
darkness is the *section's background* (CSS on `.hero`), which carries no `data-wid` — so no
block edit could address it. Section/theme editing was in v1 non-goals; this promotes it.

## Options Considered
- **(a) Anchor section/container elements too, and reuse the existing engine — CHOSEN.**
  The regeneration engine is already generic over any `data-wid` element, so style-edit
  (deterministic background) and structural-change (agent rewrite) work on sections with no
  engine change.
- (b) A separate CSS/stylesheet-editing subsystem — rejected: a whole new operation class;
  the inline-style-on-the-element approach overrides stylesheet rules and fits the model.
- (c) A global "theme" panel decoupled from selection — deferred: useful later, but doesn't
  match the point-at-it interaction; section targeting is the smaller, consistent step.

## Decision
1. **Anchoring:** `instrument` also tags section/slide containers
   (`section, header, [data-slide], .slide`) with `data-wid="section-{i}"` (document order).
   This is **additive** — existing text/image block ids are unchanged (INV-1 holds), so live
   documents keep their anchors.
2. **Targeting:** `selection.describe()` additionally reports the nearest ancestor section
   anchor. The feedback panel shows a **"this block" / "whole section"** toggle when a
   section ancestor exists; choosing "whole section" retargets the edit to the section's
   `data-wid`.
3. **Edits on a section reuse existing paths, no engine change:**
   - *Restyle* (deterministic) — style-edit sets an inline `background` (and/or text color)
     on the section, overriding the stylesheet rule. The panel gains a background-color input.
   - *Give feedback* (AI) — structural-change on the section: the agent rewrites the section
     fragment, and the **INV-2 gate guarantees every child `data-wid` survives** (so content
     isn't lost while restyling). "Type exact text" is hidden for sections (it would wipe
     children).

## Consequences
- "Too dark" now works: lighten the hero by picking a background, or by feedback the agent
  applies to the section.
- Section structural fragments are large (they contain all children); INV-2 makes that safe
  but the agent must echo children faithfully. Fine for typical sections.
- Restyling a section's background can hurt text contrast (e.g. white text on a now-light
  hero); legibility is the user's follow-up edit. A contrast-aware "theme" is a future step.
- Existing documents gain section anchors only when re-instrumented; for a live session,
  re-instrument the current head into a new version to enable section edits immediately.

## Trade-offs Accepted
Large section fragments on the AI path, and no automatic contrast handling, in exchange for
reusing the existing engine with zero changes and a consistent point-at-it interaction.
