#!/usr/bin/env node
// ensure-siblings.mjs — set up the helper tools wicked-interactive needs (ADR-0016).
//
// Run once at startup by the `serve` skill. For each MISSING sibling it runs the real
// install command — transparently: every command is printed before it runs, so the user
// always sees exactly what's happening on their machine. Nothing is installed silently.
//
//   node bin/ensure-siblings.mjs           # auto-install anything missing
//   node bin/ensure-siblings.mjs --check   # report only, install nothing
//   WI_NO_AUTOINSTALL=1 node …               # same as --check (opt out of auto-install)
//
// Cross-platform: spawnSync(..., { shell:true }) resolves `claude`/`npx` via PATH on
// macOS, Linux, and Windows.

import { spawnSync } from "node:child_process";
import { preflight, playwrightInstalled } from "../src/service/preflight.js";

// Playwright (ADR-0018) powers demo recording. It's an npm dependency, not a Claude plugin,
// so it installs differently: pull the package + browser binaries, then the skills (the
// supervising agent uses these to learn the target app). `playwright-cli install --skills`
// relies on the softlinked skill dirs in the standard locations.
const PLAYWRIGHT_STEPS = [
  "npm install playwright",
  "npx playwright install",
  "playwright-cli install --skills",
];

// Each sibling installs differently — an ordered list of shell commands per plugin.
//   prezzie / garden → Claude Code plugins (marketplace add, then install)
//   brain            → npm package, run via npx
const INSTALL_STEPS = {
  "wicked-prezzie": [
    "claude plugin marketplace add mikeparcewski/wicked-prezzie",
    "claude plugin install wicked-prezzie",
  ],
  "wicked-garden": [
    "claude plugin marketplace add mikeparcewski/wicked-garden",
    "claude plugin install wicked-garden",
  ],
  "wicked-brain": [
    "npx -y wicked-brain",
  ],
};

function run(cmd) {
  console.log(`  $ ${cmd}`);
  return spawnSync(cmd, { stdio: "inherit", shell: true }).status === 0;
}

const checkOnly = process.argv.includes("--check") || process.env.WI_NO_AUTOINSTALL === "1";

let pf = preflight();
const pwMissing = !playwrightInstalled();
if (pf.ok && !pwMissing) {
  console.log("Helper tools: all present. Nothing to install.");
  process.exit(0);
}

const wanted = [...pf.missing, ...(pwMissing ? ["playwright (demo recorder)"] : [])];
console.log(`wicked-interactive needs ${wanted.length} helper tool(s): ${wanted.join(", ")}`);

if (checkOnly) {
  console.log("\nAuto-install is off. Install these yourself, then restart:");
  if (pf.install_hint) console.log(pf.install_hint);
  if (pwMissing) console.log(pf.playwright.install_hint);
  process.exit(1);
}

console.log("\nSetting them up for you now (one time). Each command is shown before it runs:");
for (const name of pf.missing) {
  console.log(`\n• ${name}`);
  for (const cmd of INSTALL_STEPS[name]) {
    if (!run(cmd)) console.error(`  ! '${cmd}' did not succeed — continuing.`);
  }
}
if (pwMissing) {
  console.log(`\n• playwright (demo recorder)`);
  for (const cmd of PLAYWRIGHT_STEPS) {
    if (!run(cmd)) console.error(`  ! '${cmd}' did not succeed — continuing.`);
  }
}

pf = preflight();
if (pf.ok && playwrightInstalled()) {
  console.log("\nAll set — every helper tool is installed.");
  process.exit(0);
}

const stillMissing = [...pf.missing, ...(playwrightInstalled() ? [] : ["playwright"])];
console.error(`\nStill missing: ${stillMissing.join(", ")}. Finish these by hand, then restart:`);
if (pf.install_hint) console.error(pf.install_hint);
if (!playwrightInstalled()) console.error(pf.playwright.install_hint);
console.error("\n(If 'claude' isn't found, run this from inside Claude Code — that's where the plugin CLI lives.)");
process.exit(1);
