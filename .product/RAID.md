---
name: RAID
title: wicked-interactive — Risks, Assumptions, Issues, Dependencies
status: draft
version: 0.1
date: 2026-07-21
author: mike.parcewski@gmail.com
review-required: true
---

# wicked-interactive — RAID

## Risks

### R-001 — wicked-bus unavailability on service start

**Probability:** Medium (bus not started before running `serve`)
**Impact:** High — the service refuses to start (fail-fast, ADR-0021); users cannot use the product.
**Mitigation:** The service prints a clear diagnostic and auto-start hint when the bus is unreachable. The skill (`skills/serve/SKILL.md`) starts the bus before the service. This is a deliberate design choice: an optional nervous system is a correctness risk, not a feature.

### R-002 — Single-host constraint limiting adoption

**Probability:** Low (target users are local desktop users)
**Impact:** Medium — multi-machine or cloud-hosted use cases are blocked until wicked-bus ships a remote transport.
**Mitigation:** Documented as a known constraint. The bus v2 push daemon is the documented upgrade path. No workaround exists within v0.x.

### R-003 — Playwright browser binary availability for video/PDF export

**Probability:** Medium (CI skips browser download; users on restricted machines may not be able to install it)
**Impact:** Medium — video and PDF export fail; HTML and PPTX export still work.
**Mitigation:** The service performs a lazy preflight before accepting a video/PDF export request and reports a clear error with installation instructions. Export gracefully degrades to HTML.

### R-004 — TTL sweep causing agent context loss

**Probability:** Low in typical sessions (24 h TTL); medium in multi-day sessions
**Impact:** Medium — an agent offline past the 24 h wicked-bus TTL (72 h visibility) misses events emitted while it was away.
**Mitigation:** Durable state (`versions.json`, `sources.json`) is always authoritative. The agent can run `wicked-bus replay` and reconcile from workspace files to recover. Nothing the user cares about lives only on the bus (ADR-0021).

### R-005 — DataWid anchoring invariant violated by malformed generation

**Probability:** Low (LLM can drop or duplicate `data-wid` attributes under adversarial prompts)
**Impact:** Medium — FeedbackItems targeting a missing `data-wid` fail silently or throw at apply time.
**Mitigation:** The service validates `data-wid` presence after each generation cycle (INV-2 check). Violations surface as `wicked.interactive.error.raised` events, not silent failures.

### R-006 — PPTX pipeline Python dependency unavailability

**Probability:** Low on developer machines; medium in CI environments
**Impact:** Low — PPTX export fails; other formats unaffected.
**Mitigation:** Lazy preflight before accepting PPTX export request; clear error message with installation instructions.

## Assumptions

### A-001 — The agent drives document generation

The service is model-free (ADR-0001 inline). The supervising AI agent is responsible for all LLM calls (document generation, structural edits, feedback routing, vision review). The service provides infrastructure only: workspace management, the SSE bridge, and event routing.

### A-002 — The browser provides feedback collection, not autonomous editing

The browser UI is the feedback surface. It collects user intent (clicks, text input) and emits events; it does not apply edits itself. All edits are applied by the service (deterministic content/style edits via cheerio) or the agent (structural changes via LLM).

### A-003 — A single user session owns a workspace at a time

The fork model supports branching, not concurrent multi-user editing. The service is single-writer per workspace (consistent with the wicked-* single-writer pattern).

### A-004 — Users have Node.js >= 20 installed

The npm package requires Node 20+ and documents this in `engines`. Plugin install handles this for Claude Code users via the preflight check.

### A-005 — wicked-garden is available for council adapter calls

The supervising agent uses wicked-garden for vision review and complex feedback routing. wicked-garden must be installed and accessible to the agent process. The service itself has no dependency on wicked-garden.

## Issues

### I-001 — Deterministic edit latency is ≤ poll interval (500 ms)

**Status:** Known, accepted
Deterministic edits (content-edit, style-edit) went from instant (direct file watch) to ≤ 500 ms (bus poll interval) as a consequence of ADR-0019. The wicked-bus v2 push daemon (sub-10 ms) is the documented upgrade path but is not available in single-host v2.x.

### I-002 — Playwright browser binaries not bundled in npm package

**Status:** Known, accepted
The npm package ships without browser binaries (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in CI). First-time PDF/video export triggers a download step. The `preflight.test.js` covers the detection logic but not the download itself in CI.

## Dependencies

### D-001 — wicked-bus (required, hard)

| Attribute | Value |
|---|---|
| Package | `wicked-bus ^2.0.0` |
| Role | Control plane event fabric |
| Coupling | Hard — fail-fast on start (ADR-0021) |
| Owned by | wicked-* ecosystem |
| Risk if unavailable | Service will not start |

### D-002 — wicked-garden (required for agent skills, soft from service)

| Attribute | Value |
|---|---|
| Role | Council adapter for vision review and complex feedback routing |
| Coupling | Soft from the service's perspective (service has no direct dependency); hard from the agent skill's perspective |
| Risk if unavailable | Vision-review step on exports is skipped; complex structural edits may degrade in quality |

### D-003 — Playwright (required for PDF/video export)

| Attribute | Value |
|---|---|
| Package | `playwright ^1.60.0` |
| Role | Headless browser for PDF rendering and video capture |
| Coupling | Soft (feature-gated behind preflight) |
| Risk if unavailable | PDF and video export unavailable; HTML and PPTX export unaffected |

### D-004 — wicked-web (build-time)

| Attribute | Value |
|---|---|
| Package | `github:mikeparcewski/wicked-web` |
| Role | Shared site chrome (header, footer, brand assets) |
| Coupling | Build-time; bundled into `frontend/dist/` |
| Risk if unavailable | Frontend build fails; does not affect service at runtime |

### D-005 — Python toolchain (required for PPTX export)

| Attribute | Value |
|---|---|
| Role | Vendored HTML→PPTX pipeline |
| Coupling | Soft (lazy preflight) |
| Risk if unavailable | PPTX export unavailable; other export formats unaffected |
