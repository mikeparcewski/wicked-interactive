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

## The two things you fulfill

1. **Structural-change requests** — the service writes `requests/_v{n}.request.json`; you
   edit each fragment and write `requests/_v{n}.response.json`.
2. **Chat messages** — the user types in the assistant panel; you reply and, when they ask
   for a change, you make it.

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

## Step 5 — Loop

Return to watching. Keep going until the user says to stop. The session staying alive IS
the product guarantee — `serve` + `assist` together are why a non-technical user can click
a block and watch it change without ever touching a terminal.
