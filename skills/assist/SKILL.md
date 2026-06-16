---
name: assist
description: |
  Be the supervising agent in the wicked-interactive feedback loop. Subscribe to the
  wicked-bus control plane and fulfil what the browser cannot do on its own: structural
  edits, first-draft generation, demo authoring, conversational requests, and source
  indexing. Deterministic edits (exact-text, style, remove) are applied by the service the
  moment the user submits them; you handle everything that needs intelligence.

  Use when: "assist the builder", "watch for edits", "be the agent in the loop",
  "fulfill structural edits", "respond to the chat", "the UPDATE button is spinning",
  "process feedback requests", "stay in the loop", invoked automatically after `serve`
phase: loop
pipeline_position: 2
---

# assist — the agent in the loop (bus edition)

The service is **model-free infrastructure** (ADR-0010). It applies deterministic cheerio
edits, serves versions, materializes state, and bridges the bus to the browser. Anything
requiring judgment — rewriting a block, restyling a section, answering "make this more
premium", brainstorming a blank doc into a deck — is **yours**. You are the intelligence the
architecture assumes is present. There is no second embedded model; do not add one.

**Everything flows over wicked-bus (ADR-0019).** You *subscribe* to learn what the user did and
*emit* to make changes and narrate progress. One vocabulary, both directions — no request
files, no HTTP endpoints, no bespoke tail. Run this as a continuous loop until the user stops.

> **Two subscribe patterns — pick the right one for your harness:**
>
> - **Claude Code + Monitor tool** (Step 1): run a *persistent* subscribe (no `--drain`) wrapped in
>   Monitor. Monitor fires a notification on **each stdout line**, so every event wakes you the
>   instant it arrives — no drain needed, zero noise between events. The `while true` in Step 11
>   silently restarts after idle-timeout; nothing echoes.
>
> - **Any other harness** (non-Monitor background process): use `--drain` instead. Standard
>   background processes only notify on *completion*; a never-exiting subscribe would silently
>   swallow all events. `--drain` delivers pending events and exits, process-completion wakes you,
>   then you re-arm. (`--drain` is always available — wicked-bus is a pinned dep.)

## Step 0 — Set your bus identity

Every event you emit must be stamped as the agent so the service can tell your work apart from
the UI's (loop safety). Export this once at the start of the loop — `wicked-bus emit` reads it:

```bash
export WICKED_BUS_PRODUCER_ID=wi-agent
```

A tiny helper keeps emits readable — it writes the payload to a temp file and emits by
`@file` (never hand-escape JSON with embedded HTML):

```bash
wibus() {  # wibus <event_type> <subdomain> <json-payload>
  local f; f="$(mktemp)"; printf '%s' "$3" > "$f"
  wicked-bus emit --type "$1" --domain wicked-interactive --subdomain "$2" --payload "@$f"
  rm -f "$f"
}
```

## Step 0.5 — Auto-create the document when launched with an idea

**Run this step only when** both conditions hold:
1. The conversation context contains a specific topic, idea, or brief the user wants turned into
   a document (they said something like "build a presentation about X" or "make a page on Y").
2. No existing document was opened by `serve` — i.e., the browser is on the empty screen
   (no `?doc=` param in context, or `serve` opened `/` because the docs folder was empty).

**Skip this step** if the user just said "start wicked-interactive" with no content idea, or if
`serve` already opened to an existing document.

Derive a URL-safe slug from the brief, then create the document via the REST API:

```bash
# Write the creation payload to a temp file — avoids any shell JSON-escaping issues with the brief
python3 -c "
import json, sys, re
brief = '''<the full brief from context>'''
words = re.sub(r'[^a-z0-9 ]+', '', brief.lower()).split()
slug = '-'.join(words[:6])[:40] or 'new-document'
sys.stdout.write(json.dumps({'name': slug, 'kind': 'source', 'brief': brief}))
" > /tmp/wi-newdoc.json

DOC_RESPONSE="$(curl -sX POST "$BASE/api/docs" \
  -H "Content-Type: application/json" \
  -d @/tmp/wi-newdoc.json)"

DOC_NAME="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['name'])" "$DOC_RESPONSE")"
echo "Created doc: $DOC_NAME"
rm -f /tmp/wi-newdoc.json
```

`$BASE` is the URL `serve` printed (e.g. `http://localhost:4400`).

The service emits `wicked.doc.created` which the browser receives via SSE and **automatically
navigates** to `?doc=<name>` in working mode — the chat opens locked and the generation veil
shows. You do NOT need to re-open or redirect the browser.

Use `$DOC_NAME` as `document_id` in the Step 1 greeting below, and proceed straight to
Step 5 (generate first draft) after greeting — this is a `source` kind doc.

## Step 1 — Go live: greet, then arm the watch

Two actions, in order. **No version checks, no choosing between approaches** — do exactly this:

**1. Greet** so the user sees the agent is live (use the doc they have open; omit `document_id`
only if none is open yet):

```bash
wibus wicked.chat.posted chat '{"document_id":"<doc>","role":"agent","text":"I'\''m here — describe a change or click any block and I'\''ll get to work."}'
```

**2. Arm the watch.** In Claude Code, run a **persistent subscribe with the Monitor tool** — Monitor
fires on each stdout line, so every event wakes you the instant it arrives, with zero noise between
events. This is THE way — not a drain loop, not a decision to weigh:

```bash
wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' \
  --cursor-init latest --idle-timeout 120000
```

Each event arrives as one JSON envelope on stdout — `{ "event_type", "payload": { "document_id", … },
"producer_id", … }` — and Monitor delivers it to you immediately. Anything that arrives while you're
working is held by the durable cursor and delivered on the next Monitor notification (nothing lost,
nothing redelivered). When the process exits after idle-timeout, Step 11 restarts it silently.

*(Not in Claude Code? Use `--drain` instead — standard background processes only notify on
completion; a persistent subscribe would swallow events. Add `--drain`, take the batch when it
exits, then re-arm.)*

`<BASE>` is the URL `serve` printed (e.g. `http://localhost:4400`); per-doc state-plane reads
live under `<BASE>/d/<doc>/…`. From each delivered line, **skip the noise and act on the rest**:

- **Ignore your own emissions** (`producer_id: "wi-agent"`) and the service's facts
  (`wicked.version.created`, `wicked.export.requested`) — the browser handles those.
- **Act on** the actionable events:

| event_type | when | your action |
|------------|------|-------------|
| `wicked.doc.created` (kind `source`) | user gave a brief and/or files in the wizard | generate the first draft (Step 5) |
| `wicked.doc.created` (kind `demo`)   | user pointed at a live URL          | learn the app, author the spec (Step 8) |
| `wicked.feedback.processed` with `awaiting_structural > 0` | a batch left structural items for you | fulfil them (Step 3) |
| `wicked.chat.posted` (role `user`)   | user typed in chat                   | reply / make the change (Step 4) |
| `wicked.question.answered`           | user answered a question you asked   | continue the work you paused (Step 3/4) |
| `wicked.theme.learned`               | the service grabbed a URL to a PDF, OR the user pointed at a local PDF/image | read its design, synthesize + apply a theme (Step 8.5) |
| `wicked.review.requested`            | user clicked a reviewer on the right-edge tool-rail | run the named review pass (non-blocking), post the verdict (Step 8.6) |
| `wicked.source.attached`             | reference material attached          | index it into a brain, live (Step 9) |
| `wicked.status.requested`            | UI heartbeat — you've been quiet while working | post a real `working` status now, naming the current step (Step 3d) |

After you've handled an event, the Monitor stays armed — no re-arm needed mid-batch. When all
pending notifications are processed, the persistent subscribe continues listening. The durable
cursor tracks your position; anything that arrived while you were working is queued and delivered
as the next Monitor notification (nothing is lost or redelivered). Re-arm only after an
idle-timeout exit (Step 11).

## Step 2 — The one rule that must never break: preserve every `data-wid`

`data-wid` anchors map a click back to an element (ADR-0001) and keep versions navigable. The
INV-2 gate **rejects any fragment that drops a pre-existing `data-wid`** (regenerate.js) — a
rejected fragment means the user's edit silently does nothing. So:

- Build every edited fragment from the **current** element markup, not from memory.
- Keep all existing `data-wid="…"` attributes byte-for-byte. You may ADD new content (it gets
  instrumented automatically), never remove an existing anchor.
- Verify before you emit (Step 3c).

## Step 3 — Fulfil a structural request

### 3a. Read the event

A `wicked.feedback.processed` line with `awaiting_structural > 0` carries the items inline —
there's no request file to read. Its payload:

```json
{ "document_id": "<doc>", "version": 5, "awaiting_structural": 1,
  "structural_items": [ { "selector": "slide-3-card-2", "instruction": "make this punchier",
                          "fragment": "<div data-wid=\"slide-3-card-2\" data-card>…</div>" } ] }
```

`version` is the partial the service just landed — it becomes the **parent** of the version
you produce.

### 3b. Edit each fragment

For each item, produce the new `outerHTML` for that element, applying `instruction`, **keeping
every `data-wid`**. A removal is `{ "selector", "remove": true }` instead of a fragment.

### 3c. Verify, then emit `wicked.edit.completed`

Write a small Node script (don't hand-edit JSON with escaped HTML) that builds the results AND
self-checks before emitting — this is the procedure that keeps INV-2 green:

```js
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const doc = "<doc>", version = 5;            // from the event
const edited = { "slide-3-card-2": `<div data-wid="slide-3-card-2" data-card>…new…</div>` };
const items = [/* the structural_items from the event */];

const results = items.map((it) => {
  const fragment = edited[it.selector];
  const before = [...it.fragment.matchAll(/data-wid="([^"]+)"/g)].map((m) => m[1]);
  const after  = [...(fragment || "").matchAll(/data-wid="([^"]+)"/g)].map((m) => m[1]);
  const dropped = before.filter((w) => !after.includes(w));
  if (dropped.length) throw new Error(`INV-2 would drop ${dropped} on ${it.selector}`);
  const open = (fragment.match(/<div\b/g) || []).length, close = (fragment.match(/<\/div>/g) || []).length;
  if (open !== close) throw new Error(`unbalanced divs (${open}/${close}) on ${it.selector}`);
  return { selector: it.selector, fragment };
});

const payload = JSON.stringify({ document_id: doc, version, results });
const f = "/tmp/wi-edit.json"; writeFileSync(f, payload);
execFileSync("wicked-bus", ["emit", "--type", "wicked.edit.completed", "--domain", "wicked-interactive",
  "--subdomain", "feedback", "--payload", `@${f}`], { stdio: "inherit", env: { ...process.env, WICKED_BUS_PRODUCER_ID: "wi-agent" } });
console.log("emitted edit.completed with", results.length, "result(s)");
```

The service applies your results through the INV-2 gate, lands a follow-on version, and emits
`wicked.version.created` (the browser hot-reloads). If a fragment dropped an anchor, the apply
fails and the change is dead — rebuild from the current markup (`GET <BASE>/d/<doc>/doc`) and
emit again.

### 3d. Keep the user informed

Post status so the in-browser overlay reflects progress (substantive replies belong in the
browser, not just your terminal):

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"processing","message":"Reworking that card…","version":5}'
# …after the new version lands:
wibus wicked.status.posted status '{"document_id":"<doc>","state":"complete","message":"Done — updated.","version":6}'
```

**Cadence — never go silent while you work.** A long step with no status reads as a frozen UI. Post a
`working` status *before* every multi-second step (dispatching a crew, rendering, verifying, re-rendering
a PDF, a long brain query) and at each checkpoint — not just at the end. Rule of thumb: if a stretch of
work runs past ~20s with no status, post one. The browser also fires a **`wicked.status.requested`**
heartbeat (~every 20s while the doc is in a working state); when you see one, reply immediately with a
`working` status naming what you're doing **right now**. Make it real and specific — the app shows playful
filler between your updates, so yours is the substance, not more filler:

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"working","message":"Re-rendering the PDF to check the lane layout…"}'
```

**Format — write messages that scan, not blobs.** The thread renders light **markdown**, so structure
the `message` text of `wicked.status.posted` (and any `wicked.chat.posted` reply) instead of shipping a
wall of prose:

- Lead with one short line that says what changed or what's happening *now*.
- Use `-` bullets when there's more than one point; **bold** the key term per line.
- Use `` `code` `` for file/event/flag names; `[label](url)` for links.
- Blank line between blocks; keep lines short. One scannable update beats a paragraph.

Supported: `**bold**`, `*italic*`, `` `code` ``, `[label](url)`, `-`/`*` bullet lists, `1.` numbered
lists, blank-line paragraph breaks. Anything else renders as plain text — don't lean on tables or
headings. A status update is still one tight line; reserve the bulleted shape for substantive
`chat.posted` replies (a summary of what you changed, options, next steps).

If you need a decision, ask with options (renders as buttons in the lock):

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"asking","question":"Two-column or stacked?","options":["Two-column","Stacked"],"request_id":"q1"}'
```

Their choice arrives as a `wicked.question.answered` event carrying `request_id` + `answer`.

### 3e. Idempotency

The cursor is durable, so a reconnect can redeliver an event you already handled. Before
fulfilling `feedback.processed` for version N, check the doc isn't already past it:
`GET <BASE>/d/<doc>/api/versions` — if `head` already has a child of N, skip. Never produce a
second follow-on for the same handoff.

## Step 4 — Respond to chat

On a `wicked.chat.posted` event with `role: "user"`:

- **Conversational** ("what can you do?", "how do I export?") — reply with a chat post:
  `wibus wicked.chat.posted chat '{"document_id":"<doc>","role":"agent","text":"…"}'`.
- **A targeted change** ("make the hero bolder", "fix that number") — fetch the current head
  (`GET <BASE>/d/<doc>/doc`), build the edited fragment(s) preserving every `data-wid`, and emit
  `wicked.edit.completed` with `version` set to the **current head** (Step 3c). The service lands
  a follow-on from head.
- **A whole-document change** ("add a pricing slide", "make the whole thing premium", or the
  first real draft of a blank doc) — build the complete new markup, leaning on the craft
  references (design-principles for "make it premium", outline/story-arc for structure) and
  self-checking against `skills/assist/references/quality-checklist.md` before you emit. Then emit
  `wicked.draft.completed` with `{ "document_id", "html" }` (or `html_path` for a large draft,
  ADR-0019 D5). The service instruments fresh anchors, themes it, and lands a new version.
- Always post a `processing` status when you start and `complete` when the version lands, so
  the document shows the loading state.

## Step 5 — Build a document from the wizard brief and/or user content

A `wicked.doc.created` event with `kind: "source"` means the user spec'd the document in the
creation wizard. Its payload carries:
- `brief` — what the user described (may be present without source files)
- `source_paths` — files/folders the user attached (may be empty if brief-only)
- `style` — the output format: `"web"` (default), `"ppt"`, `"brochure"`, or `"doc"`

The service is model-free, so building the draft is **yours**.

**If the brief is too vague to generate confidently** (e.g. "make a doc", no context, conflicting
instructions), do NOT guess — ask one focused clarifying question via:
```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"asking","question":"What'\''s this for and who'\''s the audience?","options":["Investor update","Customer pitch","Internal report","Something else"]}'
```
Then wait for `wicked.question.answered` before generating. This is the right path when intent
is genuinely unclear — the Thread is open and the user is right there.

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"processing","message":"Reading your brief and drafting…"}'
```

- If `source_paths` is non-empty, read every entry (each a file or a folder, expand `~`).
- If `source_paths` is empty, generate from the `brief` alone — that IS the spec.
- **Honor the `style` field** — before generating, read the format-specific craft reference at
  `skills/assist/references/formats/<style>.md` for layout rules, typography constraints,
  animation policy, and the format's quality gate. The one-liners below are reminders only;
  the reference file is authoritative:
  - `web` → rich scrollable HTML with animations, interactivity, and vivid layout
  - `ppt` → fixed landscape slide layout, no animations, export-safe for PPTX
  - `brochure` → **landscape** multi-page PDF, stylized pages, print-ready
  - `doc` → minimal formatting, readable prose, content-first (like a Word doc)
- **Ground it in knowledge** — consult/ingest **wicked-brain** so the draft uses the user's real
  numbers and prior decisions (Step 6). Don't invent figures the source doesn't support.
- **Generate the document** — work the craft references under `skills/assist/references/` as a
  pipeline: format rules (formats/<style>.md) → structure (outline-method) → narrative
  (story-arc) → visual design (design-principles) → export-safe HTML (html-craft). For a
  multi-discipline brief, route through a **wicked-garden crew** (Step 7) so design + copy +
  structure are reasoned about together.
- **Self-check before you emit** — run the draft past `skills/assist/references/quality-checklist.md`
  (narrative, content, visual, export-safety). Fix structure and content before surface; keep it
  proportional.

Then emit the whole draft (fresh document — no pre-existing anchors to preserve):

```bash
# build the HTML in a Node script, write it to a file, then:
wibus wicked.draft.completed generation "$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({document_id:"<doc>",html:fs.readFileSync("/tmp/wi-draft.html","utf8")}))')"
# or for a large draft, pass it by path and skip inlining:
wibus wicked.draft.completed generation '{"document_id":"<doc>","html_path":"/tmp/wi-draft.html"}'
```

The service lands it as `_v1` and the browser hot-reloads. Post `complete`:

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"complete","message":"Here'\''s a first draft — click any block to refine it.","version":1}'
```

From here the normal click-to-edit loop (Steps 3–4) takes over.

## Step 6 — Consult project knowledge before you rewrite (wicked-brain)

Before any **structural** edit or first-draft generation (Step 3, Step 5, or the change branch
of Step 4), check whether the project's brain knows something the document should respect — prior
decisions, terminology, the customer's positioning, numbers that must stay accurate. This keeps
agent-authored content grounded instead of plausibly-wrong (ADR-0016 Slice E).

- Post `{"state":"processing","message":"Checking project knowledge…"}` so the beat reads as work.
- Query the brain for the topic (`wicked-brain:search` / `wicked-brain:query`) with a stable
  `session_id`.
- Fold any **citable** facts into the markup, and when a fact drove a choice, say so in your chat
  reply ("kept the ARR figure at $4.2M per the Q3 board deck"). If the brain returns nothing
  relevant, proceed — never block an edit on a knowledge miss.

Skip this for deterministic tweaks; those carry no authorship risk.

## Step 7 — Assemble a crew for multi-discipline requests (wicked-garden)

Some chat requests need design + copy + structure reasoned about together ("turn this into an
investor-ready deck", "make the whole thing premium and tighten the narrative"). Route these to a
**wicked-garden crew** rather than a shallow single-shot edit (ADR-0016 Slice D).

- Recognise the trigger: the request spans **more than one discipline**, asks for a whole-document
  transformation, or is open-ended enough that a crew's plan→build→review beats one edit.
- Post `{"state":"processing","message":"Assembling a crew…"}`.
- Dispatch the relevant crew/agents (via the Task tool) with the current head HTML and the goal.
- You remain the **single writer back into the loop**: take the crew's output, preserve every
  `data-wid` (Step 2), and land it via `wicked.edit.completed` (targeted) or
  `wicked.draft.completed` (whole-doc). The crew reasons; you satisfy the INV-2 gate.

For a single-discipline ask, handle it inline (Step 3/4). Crews are for breadth.

## Step 8 — Learn an app and record a demo (ADR-0018)

A `wicked.doc.created` event with `kind: "demo"` points at a **live URL** (in `payload.url`, with
an optional `brief`). The service is model-free: deciding *what to click* is yours; launching the
browser and recording is the service's. Author a deterministic Playwright spec, then ask the
service to execute + record it.

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"working","message":"Exploring the app and working out the click-path…"}'
```

### 8a. Decompose the brief into scenes, then author `demo.spec.mjs`

**Do NOT copy the brief text into a single scene.** The brief is a prose description; your job
is to reason about it and extract the logical beats — the distinct capabilities the user wants
the demo to show. Each beat becomes one `step()`.

**Scene decomposition — do this before touching Playwright:**

1. Read the `brief` from the event payload (or from `wicked.chat.posted` if the user typed it).
2. Ask: *What are the distinct things this demo should prove?* Look for:
   - Setup / context steps ("sign in", "open a project", "navigate to X")
   - The main value moments ("create a document", "generate a draft", "export to PDF")
   - Payoff / outcome moments ("here's the result", "download the file")
3. Name each scene as a **short capability label** — what the viewer should take away, not what
   the user physically clicked. Good: `"Create a document"`. Bad: `"Click the New button"`.
4. Aim for 3–6 scenes. One scene per brief sentence is usually right; merge trivial setup steps,
   split compound flows. A demo that's one scene for a multi-step brief isn't a demo.
5. **Post the scene plan and WAIT for confirmation — do NOT start recording yet.** This is an
   editorial step. The user must approve the scene breakdown before you write the spec or trigger
   the recording. Use `state: "asking"` so the UI shows the confirmation state:
   ```bash
   wibus wicked.status.posted status '{"document_id":"<doc>","state":"asking","question":"Does this scene breakdown look right?","options":["Looks good — record it","Let me adjust"]}'
   wibus wicked.chat.posted chat '{"document_id":"<doc>","role":"agent","text":"Here'\''s how I'\''m breaking this into scenes:\n- **Scene 1: ...**\n- **Scene 2: ...**\n\nDoes this look right? Say '\''looks good'\'' to start recording, or tell me what to change."}'
   ```
6. Wait for `wicked.question.answered` (button click) or `wicked.chat.posted` (typed reply)
   confirming the plan. If they want changes, update the scene list and re-confirm. Only proceed
   to Playwright and `wicked.demo.requested` after explicit approval.

**Do NOT emit `wicked.demo.requested` before the user confirms the scene plan.** Jumping
straight to recording without editorial sign-off is the mistake to avoid.

Then drive the live URL yourself (Playwright is installed) to learn the selectors. Write
`<DOCS>/<doc>/demo.spec.mjs` — a plain ES module exporting `meta` and an async `run`. You express
**only** the click-path; the service supplies `page` and the `step` annotator and owns the
browser/recording lifecycle.

```js
export const meta = {
  url: "https://staging.example.com/app",
  title: "Checkout demo",
  steps: ["Sign in", "Add Pro plan", "Checkout"],
  captionHoldMs: 2500,
};
export async function run({ page, step, meta }) {
  await page.goto(meta.url);
  await step("Sign in", async () => {
    await page.fill("#email", "demo@example.com");
    await page.fill("#password", process.env.DEMO_PW || "");
    await page.click("button[type=submit]");
    await page.waitForURL("**/dashboard");
  });
  await step("Checkout", async () => {
    await page.click("text=Checkout");
    await page.waitForSelector("text=Order confirmed");
  }, { say: "One click and the order's placed — no forms, no waiting.", holdMs: 3500 });
}
```

Rules that keep the recording deterministic and safe (unchanged from the file era): wrap every
meaningful action in `step(label, fn)`; **always narrate** (caption the meaningful beats via the
`say` 3rd arg — narrate the capability, not the on-screen data); prefer stable selectors; **never
write credentials into the spec or any version artifact** (read secrets from env at run time);
`await` your waits so the recording captures settled UI.

### 8b. Trigger the record over the bus

```bash
wibus wicked.demo.requested demo '{"document_id":"<doc>"}'
```

The service launches Chromium, runs your `run()`, captures the video + storyboard, instruments it
(fresh `data-wid` per step), lands the version, and hot-reloads. It streams `Step k: <label>`
progress as `wicked.status.posted` and emits `wicked.version.created` when the version lands (or a
`wicked.status.posted` with `state:"error"` if a step throws — fix the selector and emit
`wicked.demo.requested` again). The storyboard toolbar offers **Download video** and **GIF**.

### 8c. Refine = re-author + re-record

A demo refines through the **same loop**. When the user highlights a step and asks for a change,
it arrives as a `wicked.feedback.processed` (Step 3) or `wicked.chat.posted` (Step 4). For a demo,
"make the change" means **edit `demo.spec.mjs`** and emit `wicked.demo.requested` again — same spec
⇒ same click-path ⇒ a new version. Deterministic replay.

### 8d. Handle "Add a scene" requests from the storyboard UI

The storyboard left-sidebar has an **Add a scene** button that opens a modal. When the user
submits it, a `wicked.chat.posted` arrives with this format:

```
Add a scene: <what the user described>

Mode: add it as a new scene
  — OR —
Mode: re-record from the beginning
```

**Immediately reply in chat** to tell the user what you're about to do (even one sentence is
enough — they see the thread open). Then post `processing` status and get to work.

#### Mode: add it as a new scene

1. Read `<DOCS>/<doc>/demo.spec.mjs`.
2. Append a new `step()` block that implements what the user described. Keep the existing steps
   untouched — the new scene goes at the end of `run()` and into `meta.steps`.
3. Emit `wicked.demo.requested` — the service re-runs the full spec but the new step is the
   only new footage; the browser hot-reloads the storyboard with the extra scene card.

#### Mode: re-record from the beginning

1. Read `<DOCS>/<doc>/demo.spec.mjs`.
2. **Rewrite** the full spec: plan where the new scene fits best in the narrative, insert it at
   the right position in `run()`, update `meta.steps`, and tighten any surrounding steps that
   now flow differently.
3. Emit `wicked.demo.requested`. The service records a clean take from start to finish.

Either way, post a `complete` status with the scene count when the new version lands.

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"complete","message":"Done — added \"<scene title>\" (now <N> scenes).","version":<v>}'
```

If you have a question before starting — unclear flow, missing credentials, ambiguous
scope — **ask via `wicked.status.posted` with `state: "asking"`** (Step 3d). The question
renders as buttons in the UI lock; the user's answer arrives as `wicked.question.answered`.

## Step 8.5 — Learn a theme from a URL (ADR-0010/ADR-0020)

The user pointed at a page whose look they like ("Theme from URL"). The split is the same as a
demo: the **grab is deterministic service infra** (ADR-0010) — the service has already rendered
the URL to a PDF and announced it as `wicked.theme.learned` with `render_path` (a PDF in the doc
workspace). **The judgment — reading the design — is yours.** Do **not** re-grab the URL.

1. **Read the rendered PDF with vision.** Use the SAME technique Step 9 uses to ingest binary
   sources (wicked-brain reads pdf/images "via LLM vision") — except here you read the design
   system directly off `render_path`: the **palette** (dominant background/surface, primary,
   secondary/accent, text colors, borders), the **type** (heading vs body font family, the size
   scale, weight), the **spacing** rhythm, **card/surface treatment** (radius, padding, shadow),
   and the overall vibe (light/dark, dense/airy, formal/playful).
2. **Synthesize a theme token object** in the `src/themes/*.json` shape —
   `{name, colors, fonts, sizes, spacing, card}` (see `src/themes/corporate-light.json`). Assign
   color roles **by meaning** (the page's dominant brand color → `primary`, the call-to-action /
   link hue → `secondary`, etc.), not by raw position. Name it after the source (e.g.
   `"stripe-learned"`).
3. **Quality-gate it.** Run text/background pairs through **WCAG-AA contrast**
   (`skills/assist/references/quality-checklist.md`) and nudge any failing color until it passes —
   a learned palette that's pretty but unreadable is a regression.
4. **Write it into the doc workspace** so the apply seam can re-theme with it:
   `<DOCS>/<doc>/theme/learned.theme.json`. Narrate progress with `wicked.status.posted`
   (`state:"working"` — a non-lock state) at each beat: reading → synthesizing → applying.
5. **Apply it by re-landing head.** Once `<doc>/theme/learned.theme.json` exists, the service
   applies it **automatically at every version-creation for this doc** — the theming seam reads
   that file and re-themes with its tokens (so the learned brand sticks for all later edits too;
   you never thread tokens through the event). Just trigger a re-land: read the head version's
   HTML and emit `wicked.draft.completed` with it (or `wicked.edit.completed` for a targeted
   re-theme). The service lands a new version themed with the learned tokens and the browser
   hot-reloads. Close with a `complete` status.

The deterministic grab (service) → vision read (you) → token apply (theming seam) all ride the one
bus, reusing every existing seam. **There is nothing model-driven in the service half and nothing
deterministic in the read half** — keep that line clean (ADR-0010).

**Learn from a local PDF or image** (the tool-rail's **Style → from a PDF or image**). The user pointed at a
file on their own machine; the service does **not** grab anything — it emits `wicked.theme.learned`
with `render_path` = that file and `format: "pdf"|"image"`. Read it exactly as above (vision works
on both PDFs and images), synthesize + quality-gate + apply the same way. Nothing uploads; you read
it in place.

## Step 8.6 — Run a review pass (ADR-0023)

A `wicked.review.requested` event carries `reviewers: string[]` (any of `match`, `a11y`, `copy`,
`qe`) and `document_id`. The user wants the **current head version** reviewed — you run the passes
and post each verdict back so it lands in the conversation thread. **Review only; do not edit** —
the user decides what to act on (offer to apply fixes, don't apply unasked).

Reviews are **non-blocking and concurrent** in the UI: the user keeps editing while a review runs,
and several reviewers can be in flight at once. The rail shows a per-reviewer spinner that clears
when that reviewer's verdict lands. To keep this working, two rules:

- **Tag review progress as a review** so the UI never veils/locks the canvas for it. On any
  `wicked.status.posted` you emit *for a review*, set `review: true`:
  `wibus wicked.status.posted status '{"document_id":"<doc>","state":"working","review":true,"message":"Running the a11y pass…"}'`.
- **Close each reviewer out** with `wicked.review.completed` carrying its `reviewer` key — this is
  what clears that reviewer's rail spinner:
  `wibus wicked.review.completed review '{"document_id":"<doc>","ts":"<iso>","reviewer":"a11y","passed":true,"verdict":"✓ Contrast passes AA throughout."}'`.

For each selected reviewer, evaluate the head version's HTML and post a concise verdict. Post it as
a chat message with `role: "review"` (the UI renders these as review lines) AND/OR as
`wicked.review.completed` (which also clears the rail spinner). Including the `reviewer` key on
either lets the UI match the verdict to the right rail button:

```bash
wibus wicked.chat.posted chat '{"document_id":"<doc>","role":"review","reviewer":"match","text":"✓ Matches the ask — the brief asked for X, the page delivers X."}'
wibus wicked.review.completed review '{"document_id":"<doc>","ts":"<iso>","reviewer":"match","passed":true,"verdict":"✓ Matches the ask — the brief asked for X, the page delivers X."}'
```

| reviewer (UI name) | what to check | how |
|----------|---------------|-----|
| `match` (**Intent**) | does the version still match the **original ask/intent**? | read the SAVED intent — the **first user entry in the doc's `conversation.jsonl`** (the service seeds the creation brief / first ask there) — and compare it to the head HTML; flag drift, dropped asks, scope creep. This is why intent is persisted: judge against what was actually asked, not vibes. |
| `a11y`   | accessibility + contrast | run text/background pairs through WCAG-AA (`skills/assist/references/quality-checklist.md`); flag < 4.5:1, missing alt/landmarks, focus order |
| `copy`   | copy & clarity | tighten wording, reading level, consistency; flag jargon, hedging, inconsistent terms |
| `qe` (**Quality**) | full quality crew | for a heavier multi-perspective pass, assemble a wicked-garden crew (Step 7) — semantic + a11y + content reviewers — and synthesize their findings |

Lead each verdict with `✓` (pass) or `⚠` (issue + the specific fix). Keep each to a sentence or
two. Narrate start/finish with `wicked.status.posted` carrying `review:true` (`state:"working"` →
`complete`) — the `review:true` flag keeps the canvas un-veiled so the user keeps editing. A review
pass creates **no new version** unless the user then asks you to apply a fix.

## Step 9 — Index attached reference sources (ADR-0017)

A `wicked.source.attached` event carries `added: [{ path, note }]` — reference material to index
into a wicked-brain knowledge base, **with live progress narrated to the browser**. This is a
standing part of the loop.

1. **Flip to indexing.** `wibus wicked.source.updated sources '{"document_id":"<doc>","path":"<abs>","status":"indexing"}'`.
2. **Stream progress** with `wicked.status.posted` (`state:"working"` — a non-lock state, so the
   doc isn't covered by the overlay) at each milestone: kickoff → scope → ingesting → done.
3. **Check coverage AND freshness before ingesting.** Query the target brain first — already-indexed
   ≠ current. Compare the brain's last index time against the source's real state (`git log -1` for a
   repo, file mtimes otherwise); re-ingest if it moved.
4. **Scope sanely.** Skip `node_modules`, build artifacts, binaries, vendored deps; index the
   high-signal surface (docs, READMEs, source). Name the scope decision in chat.
5. **Land it.** `wibus wicked.source.updated sources '{"document_id":"<doc>","path":"<abs>","status":"indexed"}'`
   (or `"error"`), with a final `complete` status. Then draw on that brain when generating/updating.

Brain choice: index into the source's natural project brain when one exists; otherwise this doc's
project brain.

## Step 10 — Recover a stale cursor (WB-003)

If you were away long enough that the bus swept events past your cursor, `wicked-bus subscribe`
reports `WB-003` (cursor behind the retention window). The bus is transport, not storage
(ADR-0021) — events are gone; recover from the **state plane**, which is authoritative.

**Recovery procedure:**

1. **Bump the cursor name** — the stale cursor cannot be reset with `replay`; a fresh name is
   the fix. Use a versioned suffix: `wi-agent-v2`, `wi-agent-v3`, etc. The new cursor starts at
   `--cursor-init latest` so you don't replay old events.
2. **Reconcile from the state plane** — check what actually needs handling:
   - `GET <BASE>/d/<doc>/api/versions` — any doc still at v0 (`head: 0`)? That means a
     `wicked.doc.created (kind source)` event was missed; generate its draft now (Step 5).
   - `GET <BASE>/d/<doc>/api/sources` — any sources with `status: "pending"`? Process them (Step 9).
   - `GET <BASE>/d/<doc>/api/conversation` — any unanswered user messages? Reply (Step 4).
3. **Resume the loop** with the new cursor name.

## Step 11 — Loop (re-arm the drain)

**Before re-arming: check for orphaned docs.** Every reconnect (and every loop iteration after
handling a batch), run a quick state-plane catchup so docs created in prior sessions aren't
silently abandoned:

```bash
# Docs at v0 = created but never generated (bus event may be long gone)
curl -s <BASE>/api/docs | node -e "
  const docs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  docs.filter(d => d.head === 0).forEach(d => console.log(d.id, d.kind));
"
```

For any doc where `head === 0`:
- `kind: "source"` → generate the draft (Step 5) — the user's files are still in `source_paths`
- `kind: "demo"` → author the spec (Step 8) — the target URL is still in the doc's metadata
- Post `processing` status so the browser reflects activity immediately

> This catchup is what prevents the "user has to ask twice" failure mode where a doc is created
> in one session, the agent says "on it," then reconnects and silently ignores the pending work.
> The bus drain only delivers events the cursor hasn't seen; orphaned docs never surface again
> via the bus alone.

In Claude Code, arm a **persistent subscribe via Monitor** so the loop survives idle timeouts
without generating noise. Do this at the end of Step 1 (or immediately on re-entry):

```bash
# In Claude Code — arm via Monitor tool with this command:
export WICKED_BUS_PRODUCER_ID=wi-agent
while true; do
  wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' --idle-timeout 120000
done
```

Pass `persistent: true` to Monitor. The subscribe process blocks silently until an event arrives,
outputting exactly one JSON line per event — Monitor fires only then. When the process exits after
120s of no activity, the `while true` restarts it immediately and silently (no echo). The result:
zero chat noise between events; only real bus events ever reach you.

On each Monitor notification:
1. Act on the delivered line: ignore your own `wi-agent` emissions and service facts
   (`wicked.version.created`, `wicked.export.requested`), handle the rest (Steps 3–9).
2. If subscribe reports **WB-003**, bump the cursor name (Step 10) and re-start the Monitor
   with the new `--plugin` name.

*(Not in Claude Code? Use `--drain` in the loop instead — standard harnesses only wake on process
exit, so you need the drain to exit cleanly. Replace the subscribe line above with:
`wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' --drain --idle-timeout 120000`)*

Keep going until the user says to stop. The session staying alive IS the product guarantee —
`serve` + `assist` together are why a non-technical user can click a block and watch it change
without ever touching a terminal.
