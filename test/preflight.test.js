// preflight.test.js — ADR-0016 install gate. Detection scans WI_PLUGIN_PATHS first, so
// we point it at a temp dir we can populate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight } from "../src/service/preflight.js";
import { createMultiServer } from "../src/service/server.js";

process.env.WICKED_NO_BUS = "1";

function withFakePluginRoot(installed) {
  const root = mkdtempSync(join(tmpdir(), "wi-plugin-"));
  for (const name of installed) mkdirSync(join(root, name), { recursive: true });
  const prev = process.env.WI_PLUGIN_PATHS;
  const prevHome = process.env.HOME;
  // Also redirect HOME so the developer's actual installs can't satisfy detection through
  // the home-dir defaults — the test must see exactly what we seeded.
  process.env.WI_PLUGIN_PATHS = root;
  process.env.HOME = root;
  return () => {
    process.env.WI_PLUGIN_PATHS = prev;
    process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  };
}

test("preflight reports all-missing when no sibling plugin directories exist", () => {
  // Point search paths at a real empty dir so the home-dir defaults can't accidentally
  // detect the developer's own installations.
  const empty = mkdtempSync(join(tmpdir(), "wi-empty-"));
  const prev = process.env.WI_PLUGIN_PATHS;
  const prevHome = process.env.HOME;
  process.env.WI_PLUGIN_PATHS = empty;
  process.env.HOME = empty;            // homedir() defaults also point at the empty tree
  try {
    const out = preflight();
    assert.equal(out.ok, false);
    assert.deepEqual(out.missing.sort(), ["wicked-brain", "wicked-garden", "wicked-prezzie"]);
    assert.match(out.install_hint, /claude plugin install/);
  } finally {
    process.env.WI_PLUGIN_PATHS = prev;
    process.env.HOME = prevHome;
    rmSync(empty, { recursive: true, force: true });
  }
});

test("preflight detects plugin presence via WI_PLUGIN_PATHS", () => {
  const restore = withFakePluginRoot(["wicked-prezzie", "wicked-garden", "wicked-brain"]);
  try {
    const out = preflight();
    assert.equal(out.ok, true);
    assert.deepEqual(out.missing, []);
    assert.equal(out.install_hint, null);
  } finally { restore(); }
});

test("preflight reports the gap when only some plugins are installed", () => {
  const restore = withFakePluginRoot(["wicked-prezzie"]);
  try {
    const out = preflight();
    assert.equal(out.ok, false);
    assert.deepEqual(out.missing.sort(), ["wicked-brain", "wicked-garden"]);
    assert.equal(out.required["wicked-prezzie"].detected, true);
  } finally { restore(); }
});

test("wicked-brain is detected via ~/.wicked-brain even without a plugin-cache entry", () => {
  // Plugin cache has prezzie + garden but NOT brain; ~/.wicked-brain exists in the fake home.
  const home = mkdtempSync(join(tmpdir(), "wi-home-"));
  mkdirSync(join(home, ".claude/plugins/cache/wicked-prezzie"), { recursive: true });
  mkdirSync(join(home, ".claude/plugins/cache/wicked-garden"), { recursive: true });
  mkdirSync(join(home, ".wicked-brain"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevPaths = process.env.WI_PLUGIN_PATHS;
  process.env.HOME = home;
  process.env.WI_PLUGIN_PATHS = "";   // force the detector to rely on home-dir defaults
  try {
    const out = preflight();
    assert.equal(out.ok, true, JSON.stringify(out, null, 2));
    assert.equal(out.required["wicked-brain"].detected, true);
  } finally {
    process.env.HOME = prevHome;
    process.env.WI_PLUGIN_PATHS = prevPaths;
    rmSync(home, { recursive: true, force: true });
  }
});

test("multi-server exposes GET /api/preflight", async () => {
  const restore = withFakePluginRoot(["wicked-prezzie", "wicked-garden", "wicked-brain"]);
  const root = mkdtempSync(join(tmpdir(), "wi-pf-srv-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  try {
    const r = await fetch(`http://localhost:${port}/api/preflight`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.required["wicked-prezzie"].detected);
  } finally {
    await svc.stop();
    rmSync(root, { recursive: true, force: true });
    restore();
  }
});
