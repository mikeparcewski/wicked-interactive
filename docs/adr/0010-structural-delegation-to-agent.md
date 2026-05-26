# ADR-0010: Structural-change delegation to the supervising agent

## Status
Accepted — 2026-05-26 (product-owner correction to ADR-0003's "LLM" framing)

## Context
ADR-0003 routes `structural-change` items to a "fragment-scoped LLM". The build phase
clarified *who* that LLM is. The service is started and supervised by the `claude` CLI
(the agent) — and **that agent is already the intelligence in the loop.** There is no
second model to embed: wiring an Anthropic SDK / API client into the service would
duplicate the very agent that launched it. The service should stay model-free
infrastructure (watch, serve, deterministic cheerio surgery) and **delegate** structural
edits to the supervising agent.

## Options Considered
**Delegation channel:**
- **(a) Request/response files — CHOSEN.** Consistent with the file-watch + markdown
  paradigm the rest of the system uses; the agent already reads/writes files; trivially
  testable with a fake fulfiller.
- (b) wicked-bus request/reply — rejected for v1: requires the agent to run a persistent
  bus-subscriber loop; harder to test.
- (c) HTTP endpoint + agent polling — rejected: polling is less elegant than file-watch.

**Async behavior:**
- **(a) Partial-now, finalize-on-reply — CHOSEN.** Deterministic edits apply immediately;
  structural items finalize when the agent responds.
- (b) Hold the version until complete — rejected: makes the user wait on the agent for
  every batch containing a structural item.

## Decision
1. On a feedback batch, the service splits items into **deterministic** (content/style)
   and **structural**.
2. Deterministic items are applied immediately via cheerio, producing the next version
   `_v{n}.html` (the *partial*).
3. For structural items the service writes `requests/_v{n}.request.json`:
   `{ document_id, version, base_html: "_v{n}.html", items: [{ selector, instruction, fragment }] }`
   where `fragment` is the serialized current outerHTML of the targeted element.
4. The **supervising agent** watches `requests/`, edits each fragment per the instruction
   **preserving every `data-wid` verbatim**, and writes
   `requests/_v{n}.response.json`: `{ version, results: [{ selector, fragment }] }`.
5. The service applies the response through the **INV-2 gate** (ADR-0003): any returned
   fragment that dropped a `data-wid` is rejected. Because versions are write-once
   (INV-4), the finalized result is a **follow-on version** `_v{m}.html` (parent = n),
   not an overwrite of the partial.

## Consequences
- The service is model-free, fully testable with a programmatic fake fulfiller, and has
  no API-key dependency.
- Fast feedback for the common (deterministic) case; structural edits arrive as a
  follow-on version when the agent finishes.
- A batch with structural items yields two versions (partial + finalized) — visible and
  navigable in the version strip.
- The agent must be running/watching to fulfill requests. Automating fulfillment (a
  `/loop` or a bus-subscriber daemon) is a later option; the protocol does not require it.

## Trade-offs Accepted
Two versions per structural batch, and a dependency on an active supervising agent, in
exchange for keeping the service simple, model-free, and aligned with how the agent
already works.
