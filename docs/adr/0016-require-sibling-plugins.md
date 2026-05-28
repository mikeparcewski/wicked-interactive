# ADR-0016: wicked-interactive requires its sibling plugins

## Status
Accepted — 2026-05-28 (product-owner direction)

## Context
The brochure footer claimed "built local-first on wicked-prezzie, wicked-bus, and wicked-brain"
but in practice prezzie was *not* used (we fell back to headless Chrome in ADR-0009), the bus
was muted via `WICKED_NO_BUS=1`, and the brain held knowledge but wasn't queried during edits.
The aspirational copy didn't match reality. Earlier I argued for "optional with graceful
degradation"; PO pushed back — and was right. The product's true deployment context is the
**Claude Code plugin ecosystem**, where adding sibling plugins is one install command, not
meaningful friction. Dual-mode code (works with / without each plugin) is a code-quality and
testing tax that protects against a deployment story (standalone webapp, no Claude Code)
that *doesn't actually exist* for this product.

## Decision
wicked-interactive **requires** these sibling plugins (agent-layer dependencies):

- **`wicked-prezzie`** — theme system (palette + typography tokens), HTML→PPTX export, layout
  introspection via `chrome-extract`. Replaces ad-hoc per-section CSS and our raw
  `--print-to-pdf` shim.
- **`wicked-garden`** — multi-agent crews for complex requests in just-finish mode
  (`crew:design`, `crew:build`, `crew:review`). Routed automatically by the agent when a chat
  request spans more than one discipline; simple requests stay on the in-context agent.
- **`wicked-brain`** — knowledge queries during edits (brand voice, prior decisions, project
  conventions). Replaces ad-hoc memory reliance with citable retrieval.
- (`wicked-bus` continues to be the event spine per ADR-0004; that one is already an
  npm-published dependency and is already required, just muted in dev via env.)

### Install gate, not graceful degradation
On `serve` startup and on the editor's first load, a **preflight** probes for the four
plugins. Missing any → block with a clear install message:
```
wicked-interactive needs these Claude Code plugins installed:
  • wicked-prezzie  • wicked-garden  • wicked-brain
Run:  claude plugin install wicked-prezzie wicked-garden wicked-brain
Then come back.
```
Service refuses to serve until present. UI shows the same blocker over the document.

### Honest footer
The brochure's tagline is corrected from the aspirational original to "Built local-first on
wicked-prezzie, wicked-garden, and wicked-brain. Driven by Claude Code." — which becomes
true once integrations land.

### Implementation phasing
This ADR is the doctrine. Implementation lands across slices:
- **Slice A (landed):** ADR + new-doc modal precursor fix + honest footer rewrite. No
  preflight enforcement yet.
- **Slice B (landed):** `GET /api/preflight` on both the multi-server and legacy server
  (path-based detection: plugin caches for prezzie/garden, `~/.wicked-brain` for brain);
  blocking `<InstallGate>` modal in the editor with the install command + per-plugin
  status. New-doc flow pivoted (2026-05-28): HTML is now optional; an empty doc lands on
  a placeholder shell with the chat panel open, so the agent + user co-author from a
  blank slate via chat. Detection paths are overrideable via `WI_PLUGIN_PATHS` (tests
  + non-default installs).
- **Slice C:** theme system (prezzie tokens applied as a base style block per version).
- **Slice D:** crew-spawn affordance + auto-route complex chat requests (garden).
- **Slice E:** brain queries in the agent loop (citable retrieval).

## Consequences
- Setup gets one extra command (`claude plugin install ...`) once per workstation.
- Code path collapses — no `if (themeAvailable) … else …` branches.
- The footer and marketing copy are *honest* (the plugins are actually used).
- Lock-in to the Claude Code plugin ecosystem is explicit, not implicit. Acceptable: the
  product's value prop already requires Claude Code as the agent layer.

## Trade-offs Accepted
A one-command install gate in exchange for first-class theme + crews + knowledge and an end
to dual-mode code paths.
