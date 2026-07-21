---
name: REQ-001-application-overview
title: wicked-interactive — Application Overview
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — Application Overview

## Purpose

wicked-interactive is an interactive HTML and presentation builder for non-technical business users. The user describes what they want in plain language; an AI agent generates the document as real, interactive HTML that renders live in the browser. The user then points at elements in the browser and says what to change — the agent applies the changes and the browser updates. Every iteration is saved as a new version; any version can be rewound to or forked. The finished document can be exported as self-contained HTML, PDF, native PowerPoint (PPTX), or a narrated video.

The product operates entirely in the browser after initial setup. There is no design tool, no code editor, and no terminal visible to the end user during a session.

The control plane is wicked-bus (ADR-0019). The UI, the service, and the agent all share one event vocabulary under the domain `wicked-interactive`. The service bridges the bus to the browser via SSE (events down) and a whitelisted POST endpoint (events up). The state plane — versioned workspace files — is independent of the bus; durable state is always on disk, not in-transit messages.

## Core User Flows

### Flow 1 — Create a document from a description

1. User says what they want (e.g., "Build me a Q3 results deck").
2. The agent generates the first draft as an HTML document and writes it to the workspace (`_v1.html`).
3. The service emits `wicked.interactive.draft.completed`; the browser receives it via SSE and renders the document in an iframe.
4. The user sees a live, interactive first draft without any code or file management.

### Flow 2 — Give feedback and see the update

1. The user clicks an element in the browser or types an instruction in the chat.
2. The browser emits `wicked.interactive.feedback.submitted` (UI → bus via POST /api/events).
3. The service writes the feedback as a `_v{x}.md` feedback file (YAML frontmatter + per-element edit blocks keyed by `data-wid` selector).
4. The agent picks up `wicked.interactive.feedback.processed`, applies the edits, and writes `_v{x+1}.html`.
5. The service emits `wicked.interactive.version.created`; the browser hot-reloads the iframe.

### Flow 3 — Rewind or fork a version

1. The user selects a previous version from the version history panel.
2. To rewind: the service swaps the active pointer in `versions.json`; the browser reloads.
3. To fork: the service creates a parallel version branch; both branches are independently editable and viewable side by side.

### Flow 4 — Attach source files and use real data

1. The user drops files or folders onto the browser UI.
2. The browser emits `wicked.interactive.source.attached`; the service records them in `sources.json`.
3. On the next generation cycle the agent reads the attached sources so the document reflects the user's real figures, not placeholders.

### Flow 5 — Export

1. The user requests an export (HTML, PDF, PowerPoint, or video) from the browser.
2. The service receives the request and renders the artifact (using Playwright for PDF/video; a vendored pipeline for PPTX).
3. The service emits `wicked.interactive.export.generated`; the supervising agent performs a vision review before the user is notified.
4. Once reviewed, the service emits `wicked.interactive.export.reviewed` and delivers the artifact.
