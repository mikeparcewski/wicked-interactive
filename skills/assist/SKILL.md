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
> silently hangs. The fix (Step 1) is a **self-exiting drain**: a tiny watcher that exits the
> instant a new event lands, which is what re-invokes you. Re-arm it every loop (Step 11).

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

## Step 1 — Subscribe to the loop (durable tail + self-exiting drain)

`wicked-bus subscribe` prints one JSON event per line, and its cursor is **durable** — events
that arrive while you're away replay when you reconnect (this is why there's no "reconcile on
restart" dance anymore). But a `subscribe` tail **never exits**, and most agent harnesses only
re-invoke the agent when a backgrounded process **completes**. A passive never-ending tail
therefore never wakes you: new events pile up unread and the loop silently hangs. So split the
job in two — **one** durable subscriber that only advances the cursor and captures events to a
tail file, and a short **self-exiting watcher** whose *completion* is what wakes you.

**1a. Start the durable subscriber once, in the background, writing to a tail file.** This is
the single source of truth for the cursor — do **not** start a second `subscribe` on the same
plugin/cursor (ADR-0021: the bus is transport, not storage; a second subscriber would split or
steal the durable cursor). It captures every event to a file so the watcher and you can read it:

```bash
PORT="${WI_PORT:-4400}"                  # the port serve printed — namespaces the tail files
TAIL="/tmp/wi-bus-tail.$PORT.ndjson"
ERR="/tmp/wi-bus-tail.$PORT.err"
PID="/tmp/wi-bus-sub.$PORT.pid"          # records the live subscriber so re-runs don't double it

# Kill any stale subscriber from a previous run BEFORE arming a new one — two subscribers on the
# same plugin/cursor would split or steal the durable cursor (ADR-0021) and interleave the tail.
[ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null && sleep 0.5

: > "$TAIL"                               # truncate ONCE, only when first arming the subscriber
wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' \
  --cursor-init latest --poll-interval-ms 1000 >> "$TAIL" 2>"$ERR" &
echo $! > "$PID"                          # the subscriber's pid — Step 11 reads this to check it's alive
```

**Single-subscriber discipline.** The kill-stale-then-arm above guarantees exactly one live
subscriber per port even if the loop (or the whole session) is re-run — a re-entrant `assist`
would otherwise leave the previous `wicked-bus subscribe` orphaned and double-writing the tail.
Truncate `$TAIL` **only here**, when first arming — never re-truncate it while the loop is live
(a genuine restart replays past events into the fresh file via the durable cursor; re-truncating
mid-loop would discard unread lines). Namespacing `$TAIL`/`$ERR`/`$PID` by `$PORT` keeps two
assist loops on the same machine from colliding.

Each appended line is an event envelope:
`{ "event_type", "payload": { "document_id", … }, "producer_id", … }`.

**1b. Arm a self-exiting drain watcher in the background — it exits the moment a new event
lands, and that completion re-invokes you.** Record the current tail size as a baseline, poll
~every second, and exit `0` as soon as the file grows past the baseline; bail out on an idle
timeout so the loop can re-arm even during a quiet stretch:

```bash
# baseline = where we've already read up to (byte offset into the tail file)
BASELINE=$(wc -c < "$TAIL" | tr -d ' ')
( IDLE=0
  until [ "$(wc -c < "$TAIL" | tr -d ' ')" -gt "$BASELINE" ]; do
    sleep 1; IDLE=$((IDLE + 1))
    [ "$IDLE" -ge 300 ] && exit 2   # ~5 min idle → exit so the loop re-arms
  done
  exit 0 ) &                         # exits 0 the instant a new event arrives
```

The watcher is the backgrounded process the harness watches; when it **completes** (exit 0 = a
new event, exit 2 = idle), you wake.

**1c. On wake, freeze the read boundary, read up to it, and advance the baseline *before* you
handle anything.** This ordering is the rule that prevents lost events: snapshot the current
end-of-file as `READ_TO`, read exactly the bytes in `(BASELINE, READ_TO]`, then set
`BASELINE=$READ_TO` **now**. Any event the durable subscriber appends while you're busy handling
the batch lands past `READ_TO`, so the next watcher fires on it instead of skipping it:

```bash
READ_TO=$(wc -c < "$TAIL" | tr -d ' ')                 # freeze the boundary BEFORE handling
NEW=$(tail -c +"$((BASELINE + 1))" "$TAIL" | head -c "$((READ_TO - BASELINE))")
BASELINE=$READ_TO                                       # advance NOW, not after handling
printf '%s\n' "$NEW"                                    # the new event lines, ready to act on
```

> **Never recompute the baseline from a fresh `wc -c` *after* handling the batch.** A draft or
> crew run can take minutes; an event that arrives during that window would land between your read
> and the post-handling `wc -c`, and a baseline jumped to the new EOF would skip it permanently —
> and because the durable subscriber auto-acks as it writes, a restart won't replay it either.
> Always advance the baseline to the boundary you actually read (`READ_TO`), at read time.

`<BASE>` is the URL `serve` printed (e.g. `http://localhost:4400`); per-doc state-plane reads
live under `<BASE>/d/<doc>/…`. From those new lines, **skip the noise and act on the rest**:

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
| `wicked.source.attached`             | reference material attached          | index it into a brain, live (Step 9) |

After you've handled the batch, arm a fresh watcher (Step 11, Step 1b) against the
**already-advanced** `$BASELINE` — do **not** touch `BASELINE` again here. The durable subscriber
keeps running across all of this; only the watcher is re-armed each loop.

> **Reminder:** the watcher's *exit* is what wakes you — never substitute a passive
> `wicked-bus subscribe` tail and assume it'll re-invoke you. It won't.

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

Return to watching by **re-arming the self-exiting watcher**, not by waiting on a passive tail.
The durable subscriber from Step 1a stays running the whole time; each loop you only:

1. **Do not recompute the baseline here.** It was already advanced to the exact boundary you read
   in Step 1c (`READ_TO`); recomputing it from a fresh `wc -c` after handling would skip any event
   that arrived while you were busy. Carry `$BASELINE` forward unchanged.
2. **Check the subscriber is still alive** — it's the only thing that grows the tail file, so a
   dead subscriber means a watcher that idles forever over a file nothing writes to. If your last
   watcher woke on the **idle timeout** (exit 2), confirm liveness before re-arming:

   ```bash
   if ! kill -0 "$(cat "$PID")" 2>/dev/null || grep -q 'WB-003\|WB-006' "$ERR"; then
     # subscriber died or fell behind the retention window → go to Step 10 (recover + restart 1a)
   fi
   ```
   (Read the pid from `$PID` — the shell var from Step 1a doesn't survive across separate
   command invocations; the file does.)

   On exit 0 (a real event), skip straight to handling.
3. Re-arm the background watcher from Step 1b (it exits 0 on the next event, 2 on idle).
4. On an **exit-0** completion (a real event), run Step 1c (freeze boundary → read the delta →
   advance `$BASELINE` → filter out `wi-agent` and service facts), act on the rest, then come back
   here. An **exit-2** (idle) completion carries no new bytes — do the liveness check in step 2,
   then just re-arm; don't run Step 1c on an empty delta.

> **Do NOT rely on a passive background `wicked-bus subscribe` tail to wake you** — most agent
> harnesses only signal on **process completion**, so a never-exiting tail never re-invokes you
> and events pile up unread. The self-exiting drain + re-arm in Step 1 is what keeps the loop
> live. Re-arm it every iteration.

Keep going until the user says to stop. The session staying alive IS the product guarantee —
`serve` + `assist` together are why a non-technical user can click a block and watch it change
without ever touching a terminal.
