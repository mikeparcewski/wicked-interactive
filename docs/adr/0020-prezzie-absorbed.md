---
id: wicked-interactive-adr-0020
title: "wicked-prezzie absorbed, not orchestrated"
status: active
date: 2026-06-09
---
# ADR-0020 — wicked-prezzie absorbed, not orchestrated

**Status:** accepted 2026-06-09.

**Context.** wicked-prezzie was a *required sibling plugin*: themes were read off its plugin
cache and the agent "drove its skills." Of its 40 skills / 25 Python modules, most are
superseded by the browser loop (collaborate/feedback/start), wicked-brain (learn/search/index — <!-- historical -->
itself since retired into wicked-estate, ADR-0026), or wicked-garden crews (workflow/personas).

**Decision.** Absorb the durable assets in-repo: the 3 theme JSONs move to `src/themes/`
(`theme-source.js` resolves there, no cache probing); the craft methodology becomes curated
references under `skills/assist/references/`. The HTML→PPTX Python pipeline — prezzie's one
genuinely unique asset — is a vendored, lazily-preflighted stretch (own plan). wicked-prezzie is
dropped from preflight/ensure-siblings and the repo is deprecated.
