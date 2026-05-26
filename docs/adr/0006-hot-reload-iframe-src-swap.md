# ADR-0006: Hot-reload via iframe `src` swap

## Status
Accepted — 2026-05-26 (ratifies council; v1)

## Context
On a new version, the browser must redisplay without a full navigation, preserving the
user's scroll position and their in-progress annotation overlay (AC-15, AC-16).

## Options Considered
- **(a) iframe `src` swap — CHOSEN for v1.** Clean isolation, native scroll
  preservation, avoids innerHTML-injection hazards.
- (b) morphdom in-place DOM patching — deferred: finer-grained updates but iframe
  sandbox/script re-execution edge cases.
- (c) Full page reload — rejected: resets scroll, loses selection and overlay.

## Decision
The local service serves each `_vN.html` from the same origin (no `sandbox` attribute
for local dev). The React app embeds the document in an iframe and **swaps the iframe
`src`** to the new version on the SSE `presentation.html.updated` signal. The
feedback/annotation overlay lives in the React component tree **above** the iframe,
keyed to `data-wid` (not DOM position), so it survives the swap. Scroll is preserved by
the src swap, with explicit save/restore as a backstop.

## Consequences
- No React-managed innerHTML injection into the iframe (a known minefield).
- The overlay-above-iframe architecture is a required consequence of this choice.
- Revisit morphdom only if partial-update granularity becomes necessary.

## Trade-offs Accepted
An iframe `src` swap reloads the whole document (cheap on localhost) rather than
surgically patching the changed node.
