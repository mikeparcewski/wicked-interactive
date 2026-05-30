# Architecture Decision Records

Decisions for the Interactive HTML & Presentation Builder. Produced via the
`decide` archetype on 2026-05-26, seeded by a multi-model council (Claude / Gemini /
Copilot, 3/3 consensus) and four product-owner selections.

| ADR | Decision | Origin |
|-----|----------|--------|
| [0001](0001-element-anchoring-data-wid.md) | Element anchoring via injected `data-wid` IDs | Council consensus |
| [0002](0002-feedback-file-schema-and-authorship.md) | `_v{x}.md` schema + service-as-single-writer | Council + PO select |
| [0003](0003-regeneration-engine-hybrid.md) | Determinism-first hybrid regen + INV-2 ID gate | Council consensus |
| [0004](0004-wicked-bus-event-taxonomy.md) | wicked-bus event taxonomy + payloads | Council consensus |
| [0005](0005-service-home-new-package.md) | New `wicked-interactive` package | PO select |
| [0006](0006-hot-reload-iframe-src-swap.md) | Hot-reload via iframe `src` swap | Council consensus |
| [0007](0007-in-flight-update-fifo-queue.md) | In-flight UPDATE → FIFO queue (refines AC-9) | PO select |
| [0008](0008-version-data-model-parent-pointer.md) | Version model: parent-pointer manifest | PO select |
| [0009](0009-export-pipeline.md) | Export: self-contained HTML + PDF via prezzie | Council consensus |
| [0010](0010-structural-delegation-to-agent.md) | Structural-change delegation to the supervising agent | PO correction |
| [0011](0011-section-theme-editing.md) | Section & theme-level editing | PO select |
| [0012](0012-agent-status-and-clarification-channel.md) | Agent status & clarification channel + processing lock | Build phase |
| [0013](0013-inline-comments-agent-intent.md) | Inline comments + agent-mediated intent | Build phase |
| [0014](0014-conversational-panel.md) | Conversational panel (agentic editing assistant) | PO select |
| [0015](0015-multi-document.md) | Multi-document support | PO select |
| [0016](0016-require-sibling-plugins.md) | wicked-interactive requires its sibling plugins | PO select |
| 0017 | Sources panel (referenced in code; ADR not yet written) | — |
| [0018](0018-demo-kind-record-replay.md) | Demo doc-kind: agent-authored spec, service-recorded replay | PO feature |

Each ADR follows: Status · Context · Options Considered · Decision · Consequences ·
Trade-offs Accepted. Requirements they trace to: see `../requirements.md`.
