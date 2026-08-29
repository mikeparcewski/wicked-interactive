---
id: wicked-interactive-adr-0026
title: "wicked-brain retired; grounding moves to wicked-estate via wicked-garden"
status: active
date: 2026-08-12
---
# ADR-0026 — wicked-brain retired; grounding moves to wicked-estate via wicked-garden

**Status:** accepted 2026-08-12. Supersedes the brain half of ADR-0021 (and the brain entry in
the ADR-0016 install gate); the bus half of ADR-0021 stands.

**Context.** ADR-0021 made wicked-brain a required sibling because the brain was how authored
content stayed grounded (assist Steps 6 + 9). The wicked ecosystem has since retired
wicked-brain: its memory/knowledge/search consolidated into **wicked-estate**, with
wicked-garden's `mem` and `search` skill domains as the agent surface. The estate-backed context
stack passed its Phase-5 exit gate end-to-end, so the brain probe became dead weight — it gated
the editor on a tool that no longer ships.

**Decision.** Drop the wicked-brain probe from `preflight.js` / `ensure-siblings.mjs` and the
install gate; `wicked-garden` is the one remaining sibling (its plugin brings the estate-backed
stores along). The assist skill grounds through `wicked-garden-mem` — `recall`/`answer` where it
called `wicked-brain:search`/`query` (Step 6), `ingest` where it indexed sources into a brain
(Step 9). No user data is touched: any existing `~/.wicked-brain` directory is left in place
(the brain-side migration into estate owns that lifecycle).
