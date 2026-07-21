---
name: REQ-003-domain-model
title: wicked-interactive — Domain Model
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Domain Model

## Purpose

Core domain concepts, their definitions, and their relationships. This is not a data schema; it is the vocabulary that code, tests, and documentation share.

## Concepts

### Document

A named artifact being built — a deck, one-pager, landing page, or demo video script. A Document is identified by a `document_id` (string, carried in every event payload). It owns a workspace directory under `--root`.

### Workspace

The on-disk directory for a Document. Contains all versions, feedback files, sources, the conversation log, theme data, and the lockfile. The Workspace is the durable state; the bus is transport.

Key files in a Workspace:

| File | Purpose |
|---|---|
| `versions.json` | Ordered list of versions, active pointer, fork graph |
| `_v{n}.html` | Rendered HTML for version n |
| `_v{n}.md` | Feedback file targeting version n (produced by the UI/agent before editing) |
| `sources.json` | Registry of attached source files/directories |
| `conversation.jsonl` | Full chat history (one JSON object per line) |
| `.wi-serve.json` | Lockfile: `{ port, host, pid, startedAt, version }` — written by the service, deleted on exit (ADR-0022) |

### Version

A numbered snapshot of a Document (`_v{n}.html`). Every user-visible change to a Document creates a new Version; nothing is mutated in place. Versions form a linear chain by default; a Fork creates a branch.

### FeedbackItem

A single requested change to a specific HTML element within a Document Version, keyed by its `data-wid` selector. A FeedbackItem has one of four types:

| Type | Required fields | Meaning |
|---|---|---|
| `content-edit` | `value` | Replace visible text or inner HTML |
| `style-edit` | `style` map and/or `class_add`/`class_remove` | Change visual styling |
| `structural-change` | `instruction` (free text) | LLM-driven restructuring |
| `remove` | none (beyond selector + type) | Delete the element |

Multiple FeedbackItems are collected into a FeedbackFile (`_v{n}.md`).

### FeedbackFile

A Markdown file with YAML frontmatter followed by `## item: <selector>` blocks, one per FeedbackItem. Frontmatter fields: `version` (target version number), `base_html` (the HTML file being edited), `timestamp`, and optionally `author`. Parsed and serialized by `src/core/feedback-schema.js` (`parseFeedback` / `serializeFeedback`).

### DataWid

A stable, unique `data-wid` attribute injected into every addressable HTML element (ADR-0002). DataWids are the selectors used in FeedbackItems. They survive regeneration cycles because the agent is instructed to preserve them; this is the anchoring invariant (INV-2) that makes the feedback model work.

### ForkBranch

An independent line of editing that diverges from a parent Version. A ForkBranch owns its own sub-sequence of Versions. Both the original branch and the fork are live and independently editable; the user can view them side by side. Fork structure is recorded in `versions.json`.

### ExportArtifact

A delivery-ready file produced from a Document Version. Supported formats: HTML (self-contained), PDF (via Playwright), PowerPoint/PPTX (vendored Python pipeline), video (Playwright screen-capture + narration). An ExportArtifact is ephemeral — regenerated on demand — and is not stored in `versions.json`.

### EventType

One of the 22 named event types in `src/service/events.js` that the UI, service, and agent use to communicate. Every EventType has a fixed subdomain, a type-ownership list (which producers may emit it), and a `uiEmittable` flag (whether the browser may POST it). See REQ-002 and DES-001 for the full vocabulary.

### Producer

One of the three actors in the loop: `wi-service` (Node.js service), `wi-agent` (supervising AI agent), `wi-ui` (browser). Every bus event carries its producer's identity; consumers use it to detect and drop their own reflections (loop-safety rule in ADR-0019).

### Theme

A named style profile that governs the visual character of a generated Document (color palette, typography, spacing). Themes are resolved from `src/themes/` (absorbed from wicked-prezzie, ADR-0020). The agent can apply or change a theme in response to `wicked.interactive.theme.requested`.

## Relationships

```
Workspace
  └── Document (1)
        ├── versions.json
        ├── Version 1..N ──── FeedbackFile (0..1 per version)
        │     └── DataWid (1..M per HTML element)      │
        │                                               └── FeedbackItem 1..K
        ├── ForkBranch 0..M (each owns sub-sequence of Versions)
        ├── sources.json ──── SourceFile 0..N
        └── ExportArtifact 0..N (on-demand, not versioned)
```

Every inter-actor interaction is mediated by an EventType emitted by exactly the Producers authorized to emit it.
