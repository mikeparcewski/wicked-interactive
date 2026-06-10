// preflight.js — detect required sibling tools (ADR-0016; prezzie absorbed in ADR-0020).
//
// Each tool has its own detection rule because they install differently:
//   wicked-garden  → Claude Code plugin cache (a directory per plugin)
//   wicked-brain   → npm package; the on-disk signal is the brain dir under ~/.wicked-brain
//                    (or its Windows equivalent).
// (wicked-bus is a hard npm dependency opened fail-fast at serve time — ADR-0021 — so it isn't
//  a preflight gate here; if it can't open, the service refuses to start.)
//
// The plugin-cache list is overrideable via env (`WI_PLUGIN_PATHS`, colon-separated) so
// non-default installations and tests can be picked up.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Exported so service-level plugin-cache lookups (e.g. theme-source) reuse the same paths.
export function pluginSearchPaths() {
  const env = (process.env.WI_PLUGIN_PATHS || "").split(":").filter(Boolean);
  const home = homedir();
  return [
    ...env,
    join(home, ".claude/plugins/cache"),
    join(home, "alt-configs/.claude/plugins/cache"),
    join(home, ".claude-code/plugins/cache"),
  ];
}

function inPluginCache(name) {
  for (const base of pluginSearchPaths()) {
    if (existsSync(join(base, name))) return true;
  }
  return false;
}

function brainInstalled() {
  // npm package: the durable signal is the brain directory (created by `wicked-brain:init`).
  // The env override doubles as a test seam — WI_PLUGIN_PATHS sets HOME in tests, so the
  // joined path lands inside the temp dir and detection is deterministic.
  return existsSync(join(homedir(), ".wicked-brain")) || inPluginCache("wicked-brain");
}

const DETECTORS = {
  "wicked-garden":  () => inPluginCache("wicked-garden"),
  "wicked-brain":   brainInstalled,
};

// Each sibling installs differently, so a single command can't cover them. The hint shown
// in the install gate maps each MISSING tool to its real install step (garden is a Claude
// Code plugin; brain is an npm package run via npx).
const INSTALL_CMD = {
  "wicked-garden":  "/plugin marketplace add mikeparcewski/wicked-garden\n/plugin install wicked-garden",
  "wicked-brain":   "npx wicked-brain",
};

// Playwright (ADR-0018) is the demo recorder. Unlike the sibling plugins it's an npm
// dependency, so the durable signal is whether the package resolves from this project.
// (Browser binaries are a second gate surfaced at record time — Playwright throws a clear
// "Executable doesn't exist, run npx playwright install" we already wrap in recordDemo.)
// Kept OUT of `required`/`missing` so it gates only demo creation, not ordinary documents.
export const PLAYWRIGHT_INSTALL = "npx playwright install\nplaywright-cli install --skills";
export function playwrightInstalled() {
  try { require.resolve("playwright"); return true; } catch { return false; }
}

/** Snapshot the install state of every required plugin. */
export function preflight() {
  const required = {};
  for (const [name, detect] of Object.entries(DETECTORS)) {
    required[name] = { detected: detect() };
  }
  const missing = Object.keys(DETECTORS).filter((n) => !required[n].detected);
  return {
    ok: missing.length === 0,
    required,
    missing,
    install_hint: missing.length ? missing.map((n) => INSTALL_CMD[n]).join("\n\n") : null,
    // Demo-only dependency, reported alongside (not folded into `ok`/`missing`).
    playwright: { detected: playwrightInstalled(), install_hint: PLAYWRIGHT_INSTALL },
  };
}
