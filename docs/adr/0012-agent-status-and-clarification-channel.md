# ADR-0012: Agent status & clarification channel + processing lock

## Status
Accepted — 2026-05-27

## Context
AI (structural) edits are delegated to the supervising agent (ADR-0010) and can take
seconds. With nothing surfacing progress, the browser looks frozen ("nothing happened").
Two needs: the user should see that work is in flight (and be prevented from racing it),
and the agent should be able to **report progress** and **ask a clarifying question**
mid-fulfillment ("did you mean lighter background, or lighter text?").

## Options Considered
- **(a) A status/answer channel over the existing SSE + two POST endpoints — CHOSEN.**
  Reuses the live SSE spine (ADR-0006); the agent posts status/questions via HTTP; answers
  return as a file the agent reads (consistent with the request/response-file protocol).
- (b) A bidirectional WebSocket for agent↔user — rejected: heavier; SSE + POST suffices.
- (c) Block at the service and poll — rejected: no progress visibility, no questions.

## Decision
**Status channel.** `POST /api/status { state, message, version?, requestId?, question?, options? }`
broadcasts a `status` SSE event. `state ∈ queued | processing | awaiting-agent | asking |
complete | error`. The supervising agent posts here while fulfilling a request.

**Clarification.** When the agent needs input it posts `state: "asking"` with `question` +
`options[]` + `requestId`. The UI shows it; the user's choice is sent to
`POST /api/answer { requestId, answer }`, which writes `requests/{requestId}.answer.json`
(the agent reads it) and broadcasts `answer` over SSE.

**Processing lock.** The stage locks from UPDATE until the edit completes:
- deterministic-only batch → unlock when its `processed` event reports `awaiting_structural: 0`;
- batch with structural items → stay locked ("AI is reworking…") until the agent's
  finalized follow-on version arrives (`processed` with `structural: true`);
- `error` → unlock and surface the message.
This supersedes the "keep working while queued" UX (ADR-0007) for clarity — the FIFO queue
remains as the service-level race guard, but the UI now serializes user actions visibly.

## Consequences
- The browser always shows what's happening; AI edits no longer look frozen.
- The agent gains a real human-in-the-loop: it can ask before guessing.
- One more endpoint pair + SSE event type to maintain. Answers are files (auditable,
  consistent with the delegation protocol).
- Locking trades some concurrency for clarity; acceptable and explicitly requested.

## Trade-offs Accepted
A modal-ish lock during AI edits (the user waits) in exchange for an honest, legible
in-flight state and a clarification path — better than a silent, race-prone screen.
