---
id: wicked-interactive-adr-0023
title: "ChatGPT-shell UI: bottom composer, + menu (learn-a-style / reviewers)"
status: active
date: 2026-06-11
---
# ADR-0023 — ChatGPT-shell UI: bottom composer, + menu (learn-a-style / reviewers)

**Status:** accepted 2026-06-11.

**Context.** The original three-pane editor (rail / canvas / right chat) buried the conversation in
a side column and hid the product's reach. The owner wanted a ChatGPT-style shell: a collapsing
sidebar, the document as the centered canvas, one fixed bottom composer with a `+` menu, and the
existing capabilities surfaced where people expect them.

**Decision.**
- **Shell.** A collapsing sidebar (open on first session via `localStorage('wi-side-seen')`, then
  collapsed and hover-expanding), the document framed as a wide centered canvas, a **fixed bottom
  composer** in its own region (top hairline, matching the sidebar edge), and the conversation as a
  **collapsible thread** floating above the composer. Reviewer verdicts render inline as a `review`
  message kind.
- **The `+` menu reuses existing seams.** *Learn a style* → `wicked.interactive.theme.requested` (website grab
  exists; a local PDF/image now flows through the same handler with `{path}` — no grab, the agent
  reads it in place, ADR-0010 line stays clean). *Attach* → the local file picker writes nothing,
  reads in place (ADR-0017). *Record* → demo creation (ADR-0018).
- **Reviewers are an agent capability, not service logic.** The UI emits
  `wicked.interactive.review.requested {reviewers, document_id}`; the service does **not** materialize it (it's
  not a command type) — it rides the bus to the supervising agent, which runs the named passes
  (`match`/`a11y`/`copy`/`qe`) against the head version and posts verdicts as
  `wicked.interactive.chat.posted {role:"review"}`. Default trigger is the explicit **Review** action; review
  is read-only (creates no version) until the user asks to apply a fix. This keeps the model/
  deterministic split intact — judgment in the agent, transport on the bus, nothing hard-coded in
  the service.
