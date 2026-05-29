// preflight.js — detect required sibling plugins (ADR-0016).
//
// Each plugin has its own detection rule because they install differently:
//   wicked-prezzie / wicked-garden  → Claude Code plugin caches (a directory per plugin)
//   wicked-brain                    → npm package; the on-disk signal is the brain dir
//                                      under ~/.wicked-brain (or its Windows equivalent).
//
// The plugin-cache list is overrideable via env (`WI_PLUGIN_PATHS`, colon-separated) so
// non-default installations and tests can be picked up.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  "wicked-prezzie": () => inPluginCache("wicked-prezzie"),
  "wicked-garden":  () => inPluginCache("wicked-garden"),
  "wicked-brain":   brainInstalled,
};

// Each sibling installs differently, so a single command can't cover them. The hint shown
// in the install gate maps each MISSING plugin to its real install step (prezzie/garden are
// Claude Code plugins; brain is an npm package run via npx).
const INSTALL_CMD = {
  "wicked-prezzie": "/plugin marketplace add mikeparcewski/wicked-prezzie\n/plugin install wicked-prezzie",
  "wicked-garden":  "/plugin marketplace add mikeparcewski/wicked-garden\n/plugin install wicked-garden",
  "wicked-brain":   "npx wicked-brain",
};

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
  };
}
