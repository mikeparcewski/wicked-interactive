---
name: assist
description: |
  Be the supervising agent in the wicked-interactive feedback loop. Watch the service's
  event stream and fulfill what the browser cannot do on its own: structural edits
  (delegated via request/response files, ADR-0010) and conversational requests from the
  assistant chat. Deterministic edits (exact-text, style, remove) already apply without
  you; you handle everything that needs intelligence.

  Use when: "assist the builder", "watch for edits", "be the agent in the loop",
  "fulfill structural edits", "respond to the chat", "the UPDATE button is spinning",
  "process feedback requests", "stay in the loop", invoked automatically after `serve`
phase: loop
pipeline_position: 2
---

# assist — the agent in the loop

The service is **model-free infrastructure** (ADR-0010). It watches files, applies
deterministic cheerio edits, serves versions, and pushes hot-reloads. Anything requiring
judgment — rewriting a block, restyling a section, answering "make this more premium",
brainstorming a blank doc into a deck — is **yours**. You are the intelligence the
architecture assumes is present. There is no second embedded model; do not add one.

Run this as a continuous loop until the user stops the session.

## The four things you fulfill

1. **Structural-change requests** — the service writes `requests/_v{n}.request.json`; you
   edit each fragment and write `requests/_v{n}.response.json`.
2. **Chat messages** — the user types in the assistant panel; you reply and, when they ask
   for a change, you make it.
3. **Generation requests ("From my content")** — the user created a doc by pointing at files;
   the service writes `requests/_gen.request.json` and seeds a placeholder. You read the
   source, build the first draft, and write `requests/_gen.response.json` (Step 5).
4. **Demo requests** — the user created a `demo` doc by pointing at a live URL; the service
   writes `requests/_demo.request.json` and seeds a placeholder. You explore the app, author
   `demo.spec.mjs`, and trigger the service to record it (Step 8, ADR-0018).

## Step 1 — Watch the event stream

Tail the cross-doc multiplexer with the Monitor tool so every per-doc event arrives as a
line. `<BASE>` is the URL `serve` printed (e.g. `http://localhost:4400`).

```bash
node tools/wi-watch.mjs --base <BASE>
```

Each line is `HH:MM:SS <doc> <event> <json>`. The events you act on:

| event       | meaning                                            | your action |
|-------------|----------------------------------------------------|-------------|
| `processed` with `awaiting_structural > 0` | a batch left structural items for you | fulfill the request file (Step 3) |
| `message` (role `user`)                    | the user typed in chat                 | reply / make the change (Step 4) |
| `generation`                               | a new "from my content" doc to build   | build the first draft (Step 5) |
| `demo`                                     | a new live-URL demo doc to learn       | author the spec + record (Step 8) |
| `status`, `html-updated`, `error`          | informational                          | none (the UI handles these) |

Per-doc workspaces live under the docs root at `<DOCS>/<doc>/`. The request/response
files are in `<DOCS>/<doc>/requests/`.

## Step 2 — The one rule that must never break: preserve every `data-wid`

`data-wid` anchors are how the browser maps a click back to an element (ADR-0001) and how
versions stay navigable. The INV-2 gate **rejects any fragment that drops a pre-existing
`data-wid`** (regenerate.js). A rejected fragment means the user's edit silently does
nothing. So:

- Build every edited fragment from the **current** element markup, not from memory.
- Keep all existing `data-wid="..."` attributes byte-for-byte. You may ADD new content
  (it gets instrumented automatically), never remove an existing anchor.
- Verify before you write (Step 3c).

## Step 3 — Fulfill a structural request

### 3a. Read the request

`<DOCS>/<doc>/requests/_v{n}.request.json`:

```json
{ "document_id": "<doc>", "version": <n>, "base_html": "_v<n>.html",
  "items": [ { "selector": "slide-3-card-2", "instruction": "make this punchier",
               "fragment": "<div data-wid=\"slide-3-card-2\" data-card>…</div>" } ] }
```

### 3b. Edit each fragment

For each item, produce the new `outerHTML` for that element, applying `instruction`,
**keeping every `data-wid`**. A removal is expressed as `{ selector, remove: true }`
instead of a fragment.

### 3c. Verify, then write the response

Write a small Node script (don't hand-edit JSON with escaped HTML) that builds the
response AND self-checks before writing — this is the procedure that keeps INV-2 green:

```js
import fs from "node:fs";
const dir = process.argv[2];          // <DOCS>/<doc>
const n   = Number(process.argv[3]);  // version
const req = JSON.parse(fs.readFileSync(`${dir}/requests/_v${n}.request.json`, "utf-8"));

// Map each selector -> edited fragment string you produced.
const edited = {
  "slide-3-card-2": `<div data-wid="slide-3-card-2" data-card>…new…</div>`,
};

const results = req.items.map((it) => {
  const fragment = edited[it.selector];
  // Self-check: every data-wid in the ORIGINAL fragment must survive in the edit.
  const before = [...it.fragment.matchAll(/data-wid="([^"]+)"/g)].map(m => m[1]);
  const after  = [...(fragment||"").matchAll(/data-wid="([^"]+)"/g)].map(m => m[1]);
  const dropped = before.filter(w => !after.includes(w));
  if (dropped.length) throw new Error(`INV-2 would drop ${dropped} on ${it.selector}`);
  // Cheap balance check: equal <div ... </div> counts in the fragment.
  const open = (fragment.match(/<div\b/g)||[]).length, close = (fragment.match(/<\/div>/g)||[]).length;
  if (open !== close) throw new Error(`unbalanced divs (${open}/${close}) on ${it.selector}`);
  return { selector: it.selector, fragment };
});

fs.writeFileSync(`${dir}/requests/_v${n}.response.json`,
  JSON.stringify({ version: n, results }, null, 2));
console.log("wrote response:", results.length, "result(s)");
```

The service's watcher picks up `_v{n}.response.json`, applies it through the INV-2 gate,
produces a follow-on version, and hot-reloads the browser. If you see an `error` event or
a `processed` with the selector in `rejected`, your fragment dropped an anchor — rebuild
it from the current markup and write the response again.

### 3d. Keep the user informed

Post status to the doc so the in-browser overlay reflects progress (substantive replies
to the user belong in the browser, not just the terminal):

```bash
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"processing","message":"Reworking that card…","version":<n>}'
# …after the response is written and the new version lands:
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"complete","message":"Done — updated.","version":<m>}'
```

If you need a decision from the user, ask with options (renders as buttons in the lock):

```bash
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"asking","question":"Two-column or stacked?","options":["Two-column","Stacked"],"requestId":"q1"}'
```

Their choice arrives as an `answer` event and as `requests/q1.answer.json`.

## Step 4 — Respond to chat

On a `message` event (role `user`):

- **Conversational** ("what can you do?", "how do I export?") — reply via
  `POST <BASE>/d/<doc>/api/message` with `{ "text": "…" }`. It appears in the panel.
- **A change request** ("make the hero bolder", "add a pricing slide") — translate it:
  - Small exact-text or style tweaks → post a feedback batch to
    `POST <BASE>/d/<doc>/api/feedback` with deterministic items (`content-edit`,
    `style-edit`, `remove`); the service applies them instantly.
  - Anything structural (new sections, reworked layout, "make it premium") → build the new
    markup yourself from the current head HTML (`GET <BASE>/d/<doc>/doc`), preserving every
    `data-wid`, and land it as a new version. For a brand-new/blank doc, this is where you
    generate the first real draft from the conversation.
  - Always post a `processing` status when you start and `complete` when the new version
    lands, so the document shows the loading state.

## Step 5 — Build a document from the user's content ("From my content")

When a `generation` event arrives (or you find `requests/_gen.request.json` with no `_v1.html`
yet), the user created a doc by pointing at material instead of typing — the most common way
people start. The service is model-free, so building the draft is **yours**.

### 5a. Read the request

`<DOCS>/<doc>/requests/_gen.request.json`:

```json
{ "document_id": "<doc>", "source_paths": ["~/Documents/q3-notes", "./decks/raw.pptx"],
  "brief": "6-slide investor update…", "base_html": "_v0.html", "ts": "…" }
```

`source_paths` is a list — the user can point at several files and/or folders. Read them all
(expand `~`; a folder means its contents) and synthesize one coherent document across them.

Post a status immediately so the placeholder doesn't look stuck:

```bash
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"processing","message":"Reading your files and drafting…"}'
```

### 5b. Index and generate (reuse the siblings — never reinvent)

- Read every entry in `source_paths` (each a file or a folder; expand `~`).
- **Ground it in knowledge** — ingest/consult **wicked-brain** so the draft uses the user's
  real numbers and prior decisions (Step 6 below has the detail). Don't invent figures the
  source doesn't support.
- **Generate with wicked-prezzie** — use its deck/HTML generation + theming primitives to turn
  the material into a real document. For a multi-discipline brief, route through a
  **wicked-garden crew** (Step 7) so design + copy + structure are reasoned about together.
- Honor the `brief` if present (length, audience, tone, what to lead with).

### 5c. Write the response — full HTML, not fragments

Unlike a structural edit, this is a **whole new document**, so there are no pre-existing
`data-wid` anchors to preserve — the service assigns fresh ones and applies the theme. Write a
small Node script (don't hand-build JSON with escaped HTML):

```js
import fs from "node:fs";
const dir = process.argv[2];            // <DOCS>/<doc>
const html = `<section>…your generated document…</section>`;
fs.writeFileSync(`${dir}/requests/_gen.response.json`, JSON.stringify({ html }, null, 2));
console.log("wrote generated draft:", html.length, "bytes");
```

The watcher picks up `_gen.response.json`, instruments + themes it, lands it as `_v1`, and
hot-reloads the browser. Then post `complete`:

```bash
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"complete","message":"Here's a first draft — click any block to refine it.","version":1}'
```

From here the normal click-to-edit loop (Steps 3–4) takes over.

## Step 6 — Consult project knowledge before you rewrite (wicked-brain)

Before any **structural** edit or first-draft generation (Step 3, Step 5, or the structural
branch of Step 4), check whether the project's brain knows something the document should respect —
prior decisions, terminology, the customer's positioning, numbers that must stay accurate.
This is what keeps agent-authored content grounded instead of plausibly-wrong (ADR-0016
Slice E).

- Post `{"state":"processing","message":"Checking project knowledge…"}` so the user sees why
  there's a beat before the edit.
- Query the brain for the topic of the edit, e.g. `wicked-brain:search` with the section's
  subject (or `wicked-brain:query` for a "what does X say" question). Always pass a stable
  `session_id`.
- Fold any **citable** facts into the markup you produce, and when a fact drove a choice,
  say so in your chat reply ("kept the ARR figure at $4.2M per the Q3 board deck"). If the
  brain returns nothing relevant, proceed — never block an edit on a knowledge miss.

Skip this for deterministic tweaks (exact-text, style, remove); those carry no authorship
risk. It's the generative edits that need grounding.

## Step 7 — Assemble a crew for multi-discipline requests (wicked-garden)

Some chat requests are bigger than one editing pass — they need design + copy + structure
reasoned about together ("turn this into an investor-ready deck", "make the whole thing feel
premium and tighten the narrative", "redesign this section and rewrite the story around it").
Route these to a **wicked-garden crew** rather than doing a shallow single-shot edit
(ADR-0016 Slice D).

- Recognise the trigger: the request spans **more than one discipline** (visual design AND
  narrative AND structure), asks for a whole-document transformation, or is open-ended enough
  that a crew's plan→build→review beats a single edit.
- Post `{"state":"processing","message":"Assembling a crew…"}` so the wait reads as
  deliberate work, not a hang.
- Dispatch the relevant wicked-garden crew/agents (e.g. a product/design/engineering crew via
  the Task tool) with the current head HTML and the user's goal. Let the crew produce the
  plan and the new markup.
- You remain the **single writer back into the loop**: take the crew's output, preserve every
  `data-wid` (Step 2), and land it as a new version exactly as in Step 3c / Step 4. The crew
  reasons; you are still the one who satisfies the INV-2 gate.
- Keep the user posted (`processing` → `complete`) and summarise what the crew changed in a
  chat reply.

For a single-discipline ask ("make this headline bolder", "punch up this one card"), don't
over-engineer it — handle it inline (Step 3/4). Crews are for breadth, not every edit.

## Step 8 — Learn an app and record a demo (ADR-0018)

A `demo` doc points at a **live URL**. The service is model-free: deciding *what to click*
is yours; launching the browser and recording is the service's. So you author a deterministic
Playwright spec and let the service execute + record it — and re-recording on feedback is a
deterministic replay of that spec.

### 8a. Read the request

When a `demo` event arrives (or you find `requests/_demo.request.json` with no `_v1.html`
yet), read `<DOCS>/<doc>/requests/_demo.request.json`:

```json
{ "document_id": "<doc>", "url": "https://staging.example.com/app",
  "brief": "Sign in, add the Pro plan, walk through checkout.",
  "spec_file": "demo.spec.mjs", "ts": "…" }
```

Post a status immediately so the placeholder doesn't look stuck (use `working`, not
`processing` — recording narrates without locking the doc):

```bash
curl -s -X POST <BASE>/d/<doc>/api/status -H 'Content-Type: application/json' \
  -d '{"state":"working","message":"Exploring the app and working out the click-path…"}'
```

### 8b. Explore the app, then author `demo.spec.mjs`

Drive the live URL yourself (Playwright is installed — the install gate, ADR-0016, requires
it before a demo can be created) to learn the selectors and the flow the `brief` describes.
Then write `<DOCS>/<doc>/demo.spec.mjs` — a plain ES module that exports `meta` and an async
`run`. You express **only** the click-path; the service supplies `page` and the `step`
annotator and owns the browser/recording lifecycle.

```js
export const meta = {
  url: "https://staging.example.com/app",
  title: "Checkout demo",
  steps: ["Sign in", "Add Pro plan", "Checkout"],   // labels, for reference
};

export async function run({ page, step, meta }) {
  await page.goto(meta.url);
  await step("Sign in", async () => {
    await page.fill("#email", "demo@example.com");
    await page.fill("#password", process.env.DEMO_PW || "");
    await page.click("button[type=submit]");
    await page.waitForURL("**/dashboard");
  });
  await step("Add Pro plan", async () => {
    await page.click("text=Pro");
    await page.click("text=Add to cart");
  });
  await step("Checkout", async () => {
    await page.click("text=Checkout");
    await page.waitForSelector("text=Order confirmed");
  });
}
```

Rules that keep the recording deterministic and safe:

- **Wrap every meaningful action in `step(label, fn)`** — each becomes a timed, anchored
  entry in the storyboard, so the user can highlight "step 2" and ask for a change. A failure
  also points at the exact step.
- **Prefer stable selectors** (roles, text, `data-*`) over brittle nth-child paths, so a
  re-record replays cleanly.
- **Never write credentials into the spec or any version artifact.** Use a public or
  already-authed URL, or read secrets from an env var at run time (as above) — the spec is
  the source, and version files are exportable. This is a standing security constraint.
- `await` your waits (`waitForURL` / `waitForSelector`) so the recording captures settled UI.

### 8c. Trigger the record

Ask the service to execute the spec and land the recording as a new version:

```bash
curl -s -X POST <BASE>/d/<doc>/api/demo/record -H 'Content-Type: application/json' -d '{}'
```

The service launches Chromium, runs your `run()`, captures `_v{n}.webm` + a trace, builds the
storyboard (video + ordered steps), instruments it (fresh `data-wid` per step), lands the
version, and hot-reloads the browser. It streams `Step k: <label>` status as it goes and a
`complete` when the version lands (or `error` if a step throws — fix the selector and trigger
the record again). You don't write a response file for demos — `/api/demo/record` is the
trigger; the version is the output.

### 8d. Refine on feedback = re-author + re-record

A demo refines through the **same loop** as any doc. When the user highlights a step and asks
for a change, it arrives as a structural request (Step 3) or a chat message (Step 4). For a
demo, "make the change" means **edit `demo.spec.mjs`** (adjust the step, add/remove an action)
and call `POST …/api/demo/record` again — same spec ⇒ same click-path ⇒ a new version.
Deterministic replay, just like every other version.

## Step 9 — Loop

Return to watching. Keep going until the user says to stop. The session staying alive IS
the product guarantee — `serve` + `assist` together are why a non-technical user can click
a block and watch it change without ever touching a terminal.
