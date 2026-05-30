# ADR-0018: Demo doc-kind — agent-authored spec, service-recorded replay

## Status
Accepted — 2026-05-30 (product-owner feature: "point it at an app, learn it, give
instructions, record a demo with the Playwright CLI")

## Context
The product owner asked for a **demo** capability: point wicked-interactive at a
running application that has a UI, have the agent learn it, give plain-language
instructions ("sign in, add the Pro plan, walk through checkout"), and produce a
recorded walkthrough — and then refine that walkthrough with the same in-browser
feedback loop every document already has.

Two forces shape the design:

1. **The loop already exists.** A document is a versioned, `data-wid`-anchored HTML
   artifact; the user highlights a block, asks for a change, and the service lands a
   new version that hot-reloads (ADR-0001/0003/0006/0008). A demo should ride that
   exact loop rather than invent a parallel one.
2. **The service is model-free (ADR-0010).** The supervising agent is the only
   intelligence. Deciding *what to click* in an unfamiliar app is judgement — that
   belongs to the agent. Launching a browser, capturing video, naming artifacts, and
   versioning is deterministic infrastructure — that belongs to the service.

## Options Considered
**Execution split:**
- **(a) Hybrid — agent authors a deterministic Playwright spec, service executes +
  records it — CHOSEN.** Mirrors ADR-0003 (determinism-first) and ADR-0010 (model-free
  delegation). The agent explores the URL and writes `demo.spec.mjs`; the service runs
  it. Re-recording on feedback is a deterministic replay of the (re-authored) spec —
  same spec, same click-path, same video shape.
- (b) Agent drives the browser live each time — rejected: non-deterministic, no clean
  replay on feedback, couples the agent to the recording lifecycle.
- (c) Service infers the click-path itself — rejected: violates the model-free
  invariant (ADR-0010); the service would need an embedded model.

**Demo target:**
- **(a) Live URL only — CHOSEN.** Simplest contract; the agent explores a real running
  app. Matches the product owner's framing.
- (b) Also accept a local app the service boots — rejected for v1: process-lifecycle
  and port management is scope the loop doesn't need yet.

**Install gating:**
- **(a) Extend preflight.js + ensure-siblings.mjs with a Playwright detector — CHOSEN.**
  Consistent with ADR-0016's sibling-plugin gate. Playwright (and `playwright-cli
  install --skills`) is detected/installed there, but kept **out of** the `ok/missing`
  set — it gates *demo creation only*, never ordinary documents.
- (b) Separate ad-hoc check at demo-create time — rejected: duplicates the install
  machinery and gives the user no single place to satisfy prerequisites.

## Decision
1. **A demo is a new doc `kind`, not a new subsystem.** `versions.json` carries
   `kind: "demo"` (byte-compatible: absent ⇒ `"doc"`, per ADR-0008/INV). The iframe
   "document" is a **storyboard** — a `data-wid`-anchored HTML artifact: title, target
   URL, an embedded `<video>`, and a YouTube-style **chapter grid** below it: one
   thumbnail per step (captured at the step's resulting view), its label and timestamp,
   clickable to seek the video to that step's start (an inline, dependency-free script
   wires `data-seek` → `video.currentTime`). Unlike a document, a demo is **not
   highlight-editable** — the recorded video is the artifact, so the frontend suppresses
   the highlight-to-comment overlay for `kind:"demo"` and offers a **Download video**
   action instead of HTML/PDF export. Refinement happens through chat (see point 6).

2. **Creation seeds a placeholder and writes a work request.** `POST /api/docs` with
   `{kind:"demo", url, brief}` validates the URL (http/https), lands a v0
   `demoPlaceholder` ("Learning <url>…"), and writes
   `requests/_demo.request.json`: `{ document_id, url, brief, spec_file:
   "demo.spec.mjs", ts }`. The supervising agent watches for this (or the `demo` SSE
   event), explores the app, and authors `demo.spec.mjs`.

3. **The agent authors `demo.spec.mjs`** — a plain ES module exporting
   `meta = { url, title, steps[] }` and `async run({ page, step, meta })`. The agent
   expresses *only* the click-path; it wraps each labelled action in `step(label, fn)`.
   The spec is the **source**, kept out of the version artifacts.

4. **The service executes + records (`recordDemo`, `POST /api/demo/record`).** It owns
   the browser launch (Chromium, 1280×720), video capture, tracing, and deterministic
   artifact paths: `_v{n}.webm` + `_v{n}.trace.zip` under `recordings/`. The `step`
   annotator also captures a per-step thumbnail (`_v{n}.step{NN}.png`, the frame at the
   end of the step) for the chapter grid — best-effort, so a screenshot failure never
   aborts a recording. The service supplies `page` and the `step` annotator; it never
   decides what to click. It cache-busts the spec import (`?t=…`) so a re-authored spec
   is picked up. Video and thumbnails are served from a locked, root-absolute endpoint
   `/d/{doc}/api/demo/recording/{file}` (filename regex `^[A-Za-z0-9._-]+$`,
   content-type by extension, path-traversal-locked like ADR-0009's export-file route).

5. **The recording lands as a normal version.** `recordDemo` builds the storyboard
   HTML, instruments it (INV-1/INV-2 apply — every step gets a `data-wid`), themes it,
   writes `_v{n}.html`, records the version via the parent-pointer manifest (ADR-0008),
   and emits `HTML_UPDATED` so the browser hot-reloads (ADR-0006). Record work runs on
   the FIFO queue (ADR-0007) so it never races a concurrent regeneration.

6. **Refinement = re-author + re-record (deterministic replay).** Because a demo isn't
   highlight-editable, feedback comes through chat ("slow down on the compare step",
   "skip the settings page"). The supervising agent (ADR-0010) edits `demo.spec.mjs` and
   calls `POST /api/demo/record` again. Same spec ⇒ same click-path ⇒ a new version. The
   regenerate→hot-reload loop is unchanged; "regenerate" just means "re-record the spec".

7. **Progress narrates without locking the doc.** Recording posts `status` events with
   `state:"working"` (per-step `Step k: <label>`), which append to chat but do **not**
   raise the processing lock (ADR-0012) — the user watches the recording happen.
   `state:"complete"` on success; `state:"error"` + an `error` event on failure.

## Consequences
- A demo is just another versioned doc: the version strip, fork model, export, chat,
  and feedback loop all work with no special-casing beyond `kind`.
- Recording is deterministic and replayable — refining a demo is reproducible, and a
  failure points at the exact `step` that broke.
- The service stays model-free; the only new dependency is Playwright, gated at install
  for demos only (ordinary documents are unaffected if Playwright is absent).
- The left nav now partitions Documents vs Demos (two rail sections, distinct
  add-actions); a demo view exposes a `● Record` action and a **Download video** button
  (in place of HTML/PDF export) in the toolbar, and suppresses the editing overlay.
- Credentials are never written to version artifacts: live-URL demos use a public /
  already-authed URL, or creds live in the `brief` only — never persisted to a version
  file (standing security constraint).

## Trade-offs Accepted
- A demo requires an active supervising agent to author/re-author the spec (same
  dependency ADR-0010 already accepts for structural edits).
- A failed run can leave Playwright's randomly-named `page@<hash>.webm` in
  `recordings/` (the rename-to-`_v{n}.webm` only happens on success). `recordings/` is
  gitignored and the orphan is harmless; a future cleanup pass can sweep it.
- Live-URL-only means flaky external selectors / network can fail a record; the error
  path is clean (service stays up, error surfaced to chat) and the agent re-authors a
  more robust spec.
