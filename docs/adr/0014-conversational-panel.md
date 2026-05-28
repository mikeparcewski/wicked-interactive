# ADR-0014: Conversational panel (agentic editing assistant)

## Status
Accepted — 2026-05-27 (product-owner direction)

## Context
The inline-comment loop is precise but one-shot and opaque: the user can't see what the
agent is doing, give running guidance, or make whole-page requests. The PO asked to bring
back a left panel as a **conversation** — see the agent's thinking/progress and steer in
real time. The infrastructure is mostly present: `/api/status` + SSE already carry
agent→user messages; the only missing leg is user→agent.

## Decision
A **left conversational panel** that **coexists** with inline click-to-comment (PO choice):

- **Transcript:** a chat log of agent narration (key steps — start / decision / done), user
  guidance, and edit events ("v31 — removed the button"). Agent narration verbosity = "key
  steps" (PO choice), not silent, not a running monologue.
- **User → agent:** `POST /api/message { text }` appends `{role:"user", text, ts}` to
  `conversation.jsonl` and broadcasts an SSE `message` event. The agent's SSE listener
  receives it, the agent reads it, narrates, and acts.
- **Agent → user:** `/api/status` (already exists) also appends `{role:"agent", text, ts}`
  to the log so narration persists across reloads.
- **History:** `GET /api/conversation` returns the log; the panel seeds from it on mount and
  appends live SSE events thereafter.
- **Whole-page edits** need no block selection — a chat message with no target is a
  page-level request the agent applies across the document.
- **Inline widget gains a 3-way** target/mode: *This block* (comment, AI) · *Change text*
  (deterministic content-edit, applied instantly, no agent) · *Whole section* (comment, AI).
  "Change text" restores a fast deterministic path for exact edits (partially walks back
  ADR-0013's all-agent default — as a user-chosen option, which is the hybrid).

## Consequences
- The product becomes a **collaborative editing assistant** you converse with, not just a
  feedback widget — the agent is visible and steerable.
- Reuses the SSE spine; the only new server surface is `/api/message` + `/api/conversation`
  + conversation logging.
- The agent must now also respond to free-form chat (interpret, narrate, act) — its
  fulfillment contract widens from "fulfill a request" to "hold a conversation while editing".
- Two input modalities (inline + chat) to keep coherent; both feed the same engine + INV-2
  gate, so correctness is unchanged.

## Trade-offs Accepted
More UI surface and a broader agent role, in exchange for transparency + real-time steering.
The deterministic "Change text" option reintroduces a fast path the all-agent model removed —
intentional, and user-selected.
