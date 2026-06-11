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

> **Do NOT rely on a passive background tail to wake you.** Most agent harnesses (Claude Code
> included) only re-invoke the agent when a backgrounded process **completes** — a
> `wicked-bus subscribe` tail that never exits will never wake you, so `wicked.doc.created`,
> `wicked.chat.posted`, and `wicked.feedback.processed` pile up unread and the in-browser loop
> silently hangs. The fix (Step 1) is `wicked-bus subscribe --drain` (bus ≥ 2.1.0): it delivers
> pending events and **exits**, so process-completion wakes you — then you re-arm (Step 11).

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

## Step 1 — Subscribe to the loop (self-exiting drain)

`wicked-bus subscribe --drain` (bus ≥ 2.1.0) delivers every event pending past your **durable
cursor** — one JSON line each — then **exits 0**; `--idle-timeout <ms>` makes it first *block* for
new events (the timer resets on each delivery) and exit only once things go quiet. That self-exit
is the whole point: most agent harnesses re-invoke you only when a backgrounded process
**completes**, so a drain-then-exit subscribe is exactly what wakes you. No never-ending tail, no
tail file, no watcher — and because the cursor is durable, any event that arrives **while you're
handling a batch** is held by the bus and delivered on your *next* drain (nothing lost, nothing
redelivered).

Each loop iteration, run ONE drain. For real-time pickup, run it under your harness's per-line
stream watcher (in Claude Code, the **Monitor tool**) so each delivered line wakes you the instant
it arrives; the command self-exits after the idle window and you re-arm (Step 11):

```bash
wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' \
  --cursor-init latest --drain --idle-timeout 120000
```

Each delivered line is an event envelope:
`{ "event_type", "payload": { "document_id", … }, "producer_id", … }`.

> **Do NOT run a never-exiting `subscribe` as a fire-and-forget background task.** A plain
> background process notifies you only on *completion*, so a tail that never returns never wakes
> you and events pile up unread — that was the #11 bug. Always use the self-exiting `--drain`
> above: watch it per-line for real-time wake, or take the whole batch when it exits — either way
> it **returns**, and you re-arm.

`<BASE>` is the URL `serve` printed (e.g. `http://localhost:4400`); per-doc state-plane reads
live under `<BASE>/d/<doc>/…`. From the drained lines, **skip the noise and act on the rest**:

- **Ignore your own emissions** (`producer_id: "wi-agent"`) and the service's facts
  (`wicked.version.created`, `wicked.export.requested`) — the browser handles those.
- **Act on** the actionable events:

| event_type | when | your action |
|------------|------|-------------|
| `wicked.doc.created` (kind `source`) | user built a doc "from my content" | generate the first draft (Step 5) |
| `wicked.doc.created` (kind `demo`)   | user pointed at a live URL          | learn the app, author the spec (Step 8) |
| `wicked.feedback.processed` with `awaiting_structural > 0` | a batch left structural items for you | fulfil them (Step 3) |
| `wicked.chat.posted` (role `user`)   | user typed in chat                   | reply / make the change (Step 4) |
| `wicked.question.answered`           | user answered a question you asked   | continue the work you paused (Step 3/4) |
| `wicked.theme.learned`               | the service grabbed a URL to a PDF   | read its design, synthesize + apply a theme (Step 8.5) |
| `wicked.source.attached`             | reference material attached          | index it into a brain, live (Step 9) |

After you've handled the drained batch, **re-run the drain** (Step 11). The durable cursor has
already advanced past what you drained, so the next drain returns only new events — including
anything that arrived while you were working (the bus held it; nothing is lost or redelivered).

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

## Step 5 — Build a document from the user's content ("From my content")

A `wicked.doc.created` event with `kind: "source"` means the user created a doc by pointing at
material instead of typing. Its payload carries `source_paths` (files/folders — expand `~`) and
an optional `brief`. The service is model-free, so building the draft is **yours**.

```bash
wibus wicked.status.posted status '{"document_id":"<doc>","state":"processing","message":"Reading your files and drafting…"}'
```

- Read every entry in `source_paths` (each a file or a folder).
- **Ground it in knowledge** — consult/ingest **wicked-brain** so the draft uses the user's real
  numbers and prior decisions (Step 6). Don't invent figures the source doesn't support.
- **Generate the document** — work the craft references under `skills/assist/references/` as a
  pipeline: structure (outline-method) → narrative (story-arc) → visual design (design-principles)
  → export-safe HTML (html-craft). For a multi-discipline brief, route through a **wicked-garden
  crew** (Step 7) so design + copy + structure are reasoned about together.
- Honor the `brief` (length, audience, tone, what to lead with).
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

### 8a. Explore the app, then author `demo.spec.mjs`

Drive the live URL yourself (Playwright is installed — the install gate requires it before a
demo can be created) to learn the selectors and the flow the `brief` describes. Then write
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

## Step 10 — Recover a stale cursor (rare)

If you were away long enough that the bus swept events past your cursor, `wicked-bus subscribe`
reports `WB-003` (cursor behind the retention window). The bus is transport, not storage
(ADR-0021) — recover from the **state plane**, which is authoritative: reset the cursor
(`wicked-bus replay --cursor-id <id> --from-event-id <oldest>`) and reconcile from files —
`GET <BASE>/d/<doc>/api/sources` for any `pending` sources, `GET …/api/versions` for where each
doc actually is. Then resume the loop.

## Step 11 — Loop (re-arm the drain)

Return to watching by **re-running the Step 1 drain** — that's the whole loop. There's no durable
background subscriber to babysit and no baseline to track: each drain advances the durable cursor
as it delivers, so the next drain picks up exactly the events that arrived since (including any
that landed while you were handling the last batch — the bus held them).

1. Re-run the Step 1 `subscribe … --drain --idle-timeout` command (under your per-line watcher for
   real-time wake, or as a plain completion-wake task — either way it self-exits and returns).
2. On wake, act on the delivered lines: ignore your own `wi-agent` emissions and the service facts
   (`wicked.version.created`, `wicked.export.requested`), handle the rest (Steps 3–9), come back.
3. If a drain reports **WB-003** (cursor behind the retention window), you've been away longer than
   the bus retains — recover from the authoritative state plane (Step 10), then resume.

> **Never swap the self-exiting `--drain` for a never-exiting `subscribe` on a fire-and-forget
> background task** — that wakes you only on completion, which never comes, so events pile up
> unread (the #11 bug). The drain *returns*; that's what keeps the loop live.

Keep going until the user says to stop. The session staying alive IS the product guarantee —
`serve` + `assist` together are why a non-technical user can click a block and watch it change
without ever touching a terminal.
