// preflight.test.js — ADR-0016 install gate. Detection scans WI_PLUGIN_PATHS first, so
// we point it at a temp dir we can populate.
//
// CROSS-PLATFORM (CLAUDE.md mandate): home is redirected via BOTH process.env.HOME and
// process.env.USERPROFILE because os.homedir() ignores HOME on Windows (it reads USERPROFILE
// there). Setting only HOME made these tests pass on ubuntu/macOS but fail on windows-latest
// (v0.5.29 release). The code resolves home from HOME||USERPROFILE so the seam works on every OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, delimiter, sep } from "node:path";
import { tmpdir } from "node:os";
import { preflight, pluginSearchPaths } from "../src/service/preflight.js";
import { createMultiServer } from "../src/service/server.js";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-pf-"));

// Redirect the resolved home on EVERY platform: HOME (POSIX) + USERPROFILE (Windows).
function setHome(dir) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  };
}

function withFakePluginRoot(installed) {
  const root = mkdtempSync(join(tmpdir(), "wi-plugin-"));
  for (const name of installed) mkdirSync(join(root, name), { recursive: true });
  const prev = process.env.WI_PLUGIN_PATHS;
  // Also redirect HOME/USERPROFILE so the developer's actual installs can't satisfy detection
  // through the home-dir defaults — the test must see exactly what we seeded.
  const restoreHome = setHome(root);
  process.env.WI_PLUGIN_PATHS = root;
  return () => {
    process.env.WI_PLUGIN_PATHS = prev;
    restoreHome();
    rmSync(root, { recursive: true, force: true });
  };
}

test("preflight reports all-missing when no sibling plugin directories exist", () => {
  // Point search paths at a real empty dir so the home-dir defaults can't accidentally
  // detect the developer's own installations.
  const empty = mkdtempSync(join(tmpdir(), "wi-empty-"));
  const prev = process.env.WI_PLUGIN_PATHS;
  const restoreHome = setHome(empty);  // resolved home also points at the empty tree
  process.env.WI_PLUGIN_PATHS = empty;
  try {
    const out = preflight();
    assert.equal(out.ok, false);
    assert.deepEqual(out.missing.sort(), ["wicked-brain", "wicked-garden"]);
    assert.match(out.install_hint, /\/plugin install wicked-garden/);
    assert.match(out.install_hint, /npx wicked-brain/);
  } finally {
    process.env.WI_PLUGIN_PATHS = prev;
    restoreHome();
    rmSync(empty, { recursive: true, force: true });
  }
});

test("preflight detects plugin presence via WI_PLUGIN_PATHS", () => {
  const restore = withFakePluginRoot(["wicked-garden", "wicked-brain"]);
  try {
    const out = preflight();
    assert.equal(out.ok, true);
    assert.deepEqual(out.missing, []);
    assert.equal(out.install_hint, null);
  } finally { restore(); }
});

test("preflight reports the gap when only some plugins are installed", () => {
  const restore = withFakePluginRoot(["wicked-garden"]);
  try {
    const out = preflight();
    assert.equal(out.ok, false);
    assert.deepEqual(out.missing.sort(), ["wicked-brain"]);
    assert.equal(out.required["wicked-garden"].detected, true);
  } finally { restore(); }
});

test("wicked-brain is detected via ~/.wicked-brain even without a plugin-cache entry", () => {
  // Plugin cache has garden but NOT brain; ~/.wicked-brain exists in the fake home.
  const home = mkdtempSync(join(tmpdir(), "wi-home-"));
  // Build the cache path segment-by-segment so it is correct on every OS (no hardcoded '/').
  mkdirSync(join(home, ".claude", "plugins", "cache", "wicked-garden"), { recursive: true });
  mkdirSync(join(home, ".wicked-brain"), { recursive: true });
  const restoreHome = setHome(home);
  const prevPaths = process.env.WI_PLUGIN_PATHS;
  process.env.WI_PLUGIN_PATHS = "";   // force the detector to rely on home-dir defaults
  try {
    const out = preflight();
    assert.equal(out.ok, true, JSON.stringify(out, null, 2));
    assert.equal(out.required["wicked-brain"].detected, true);
  } finally {
    restoreHome();
    process.env.WI_PLUGIN_PATHS = prevPaths;
    rmSync(home, { recursive: true, force: true });
  }
});

test("multi-server exposes GET /api/preflight", async () => {
  const restore = withFakePluginRoot(["wicked-garden", "wicked-brain"]);
  const root = mkdtempSync(join(tmpdir(), "wi-pf-srv-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  try {
    const r = await fetch(`http://localhost:${port}/api/preflight`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.required["wicked-garden"].detected);
  } finally {
    await svc.stop();
    rmSync(root, { recursive: true, force: true });
    restore();
  }
});

// ---------------------------------------------------------------------------
// Cross-platform path regressions (CLAUDE.md mandate). These pin the v0.5.29
// windows-latest failures so they cannot silently come back on POSIX either.
// ---------------------------------------------------------------------------

test("WI_PLUGIN_PATHS is split on path.delimiter, not a literal ':' (Windows-safe)", () => {
  // Two real temp roots, joined with the PLATFORM delimiter (';' on Windows, ':' on POSIX),
  // exactly as a Windows PATH-style env var would be. The bug split on a hardcoded ':',
  // which on Windows shreds every "C:\..." entry into ["C", "\\..."]. Asserting both whole
  // paths survive in pluginSearchPaths() proves the split is delimiter-based.
  const a = mkdtempSync(join(tmpdir(), "wi-pp-a-"));
  const b = mkdtempSync(join(tmpdir(), "wi-pp-b-"));
  const prev = process.env.WI_PLUGIN_PATHS;
  const restoreHome = setHome(mkdtempSync(join(tmpdir(), "wi-pp-home-")));
  process.env.WI_PLUGIN_PATHS = [a, b].join(delimiter);
  try {
    const paths = pluginSearchPaths();
    assert.ok(paths.includes(a), `expected whole path preserved, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes(b), `expected whole path preserved, got ${JSON.stringify(paths)}`);
    // No entry was shredded into a bare drive-letter fragment.
    assert.ok(!paths.some((p) => p === "C" || p === "D"), "a path was split on a drive-letter colon");
  } finally {
    process.env.WI_PLUGIN_PATHS = prev;
    restoreHome();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("home-derived search paths use the OS separator (no hardcoded '/')", () => {
  // The cache defaults are built with path.join, so on Windows they must contain backslashes,
  // never a stray forward slash from a hardcoded ".claude/plugins/cache" literal.
  const restoreHome = setHome(mkdtempSync(join(tmpdir(), "wi-sep-home-")));
  const prev = process.env.WI_PLUGIN_PATHS;
  process.env.WI_PLUGIN_PATHS = "";
  try {
    const paths = pluginSearchPaths();
    const claudeCache = paths.find((p) => p.includes(".claude") && p.includes("cache"));
    assert.ok(claudeCache, "expected a .claude plugins cache default path");
    assert.ok(
      claudeCache.includes(join(".claude", "plugins", "cache")),
      `cache path must use the OS separator (${sep}); got ${claudeCache}`,
    );
  } finally {
    process.env.WI_PLUGIN_PATHS = prev;
    restoreHome();
  }
});

test("home is resolvable via USERPROFILE alone (Windows: os.homedir ignores HOME)", () => {
  // On Windows os.homedir() reads USERPROFILE, not HOME. brainInstalled() must follow the same
  // env the OS would, so a brain dir under a USERPROFILE-only home is detected. This is the exact
  // condition that broke "wicked-brain is detected via ~/.wicked-brain" on windows-latest.
  const home = mkdtempSync(join(tmpdir(), "wi-up-home-"));
  mkdirSync(join(home, ".wicked-brain"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevPaths = process.env.WI_PLUGIN_PATHS;
  delete process.env.HOME;                 // simulate Windows: HOME unset...
  process.env.USERPROFILE = home;          // ...USERPROFILE is the real home
  process.env.WI_PLUGIN_PATHS = "";
  try {
    const out = preflight();
    assert.equal(out.required["wicked-brain"].detected, true, JSON.stringify(out, null, 2));
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    process.env.WI_PLUGIN_PATHS = prevPaths;
    rmSync(home, { recursive: true, force: true });
  }
});
