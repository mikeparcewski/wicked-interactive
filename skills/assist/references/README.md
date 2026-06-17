# Craft references

Document-craft guidance the supervising agent draws on when generating a first draft (assist
Step 5) or making a whole-document change (Step 4) — the *method*, not a workflow engine. The
core was absorbed from wicked-prezzie (ADR-0020) and adapted for wicked-interactive's HTML decks;
the design and quality references close the visual-craft gap that absorption left open.

Read them as a pipeline — each stage builds on the last:

1. **[outline-method.md](outline-method.md)** — *structure first.* The Pyramid Principle: turn
   raw material into a governing thought + supporting points before any HTML exists.
2. **[story-arc.md](story-arc.md)** — *narrative.* Order the outline as a story (SCR, PAS,
   answer-first, …) for decks, one-pagers, and launch pages.
3. **[design-principles.md](design-principles.md)** — *visual design.* The judgment that makes a
   draft look genuinely designed, not just themed: color restraint, type ladder, whitespace,
   hierarchy, cards/accents.
4. **[html-craft.md](html-craft.md)** — *implement export-safe.* HTML/CSS that stays clickable
   (data-wid friendly), themeable, and export-clean; image sourcing; the PDF print contract.
5. **[quality-checklist.md](quality-checklist.md)** — *self-check before you hand it back.*
   Narrative, content, visual, and export-safety checks with FAIL/WARN/INFO severities.

These are guidance, not gates. The one hard rule lives in the skill (preserve every `data-wid`;
ground claims in wicked-brain). Use judgment, and keep it proportional — a quick chat tweak
doesn't need the full sweep; a first draft or whole-document change does.

## Operating policy

- **[edit-routing.md](edit-routing.md)** — *the deterministic-vs-AI ladder, on one screen.* Which
  edit/request kinds the model-free service handles deterministically vs which climb to the agent
  (and to a crew), in rank order with the GATE for each rung. Consolidates the ADR-0010 / ADR-0003
  doctrine that is otherwise scattered across `feedback-schema.js`, `regenerate.js`, and the assist
  steps. Read it when you're unsure whether something is yours to author or the service's to apply.
