// test-related.test.js — the change-scoped test selection behind `.wicked/checks.json`
// `test_targeted` (wicked-interactive#344): a touched file runs the suites that name it, and a
// source file no suite names runs everything rather than passing on nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { selectTests } from "../scripts/test-related.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway repo root: `files` maps repo-relative path → body. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "wi-test-related-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

test("selection: a module runs the suites that reach it, directly, transitively or by name", () => {
  const root = fixture({
    "src/service/server.js": `import { listenLoopback } from "./loopback.js";`,
    "src/service/loopback.js": `export const x = 1;`,
    "src/service/other.js": `export const y = 2;`,
    "bin/wicked-interactive.js": `import "../src/service/other.js";`,
    "test/a.test.js": `import { x } from "../src/service/server.js";`,
    "test/b.test.js": `const cli = join(HERE, "..", "bin", "wicked-interactive.js");`,
    "test/c.test.js": `import "../src/service/other.js"; // server.js in a comment only`,
  });
  try {
    assert.deepEqual(selectTests(["src/service/server.js"], { root }), ["test/a.test.js"]);
    assert.deepEqual(selectTests(["src/service/loopback.js"], { root }), ["test/a.test.js"], "through server.js");
    assert.deepEqual(selectTests(["bin/wicked-interactive.js"], { root }), ["test/b.test.js"], "a spawned entry point");
    assert.deepEqual(selectTests(["src/service/other.js"], { root }), ["test/b.test.js", "test/c.test.js"], "imported, and imported by the spawned bin");
    assert.deepEqual(selectTests(["test/c.test.js", "test/gone.test.js"], { root }), ["test/c.test.js"], "a touched suite runs itself; a deleted one is dropped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selection: what can't be traced runs every suite; docs run only the suites that name them", () => {
  const root = fixture({
    "src/a.js": "", "test/a.test.js": `import "../src/a.js";`, "test/b.test.js": `const f = "guide.md";`,
  });
  try {
    const all = ["test/a.test.js", "test/b.test.js"];
    const untraceable = ["src/service/orphan.js", "src/service/event-schemas/x.json", "bin/other.js", "scripts/tool.mjs",
      ".wicked/checks.json", "package.json", "package-lock.json", "frontend/dist/assets/index.js", "test/helper.mjs"];
    for (const f of untraceable) assert.deepEqual(selectTests([f], { root }), all, f);
    assert.deepEqual(selectTests(["src/a.js", "package.json"], { root }), all, "one untraceable file widens the whole selection");
    assert.deepEqual(selectTests(["README.md", "docs/x.md", "site/index.astro", "docs/shot.png"], { root }), []);
    assert.deepEqual(selectTests(["docs/guide.md"], { root }), ["test/b.test.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selection: a suite that reads a directory runs for any non-docs change; shipped skills are not docs", () => {
  const root = fixture({
    "src/a.js": "", "src/b.js": "",
    "test/a.test.js": `import "../src/a.js";`,
    "test/sweep.test.js": `for (const f of readdirSync(join(REPO, "src"))) check(f);`,
  });
  try {
    assert.deepEqual(selectTests(["src/a.js"], { root }), ["test/a.test.js", "test/sweep.test.js"], "imported + the sweep");
    assert.deepEqual(selectTests(["skills/serve/SKILL.md"], { root }), ["test/a.test.js", "test/sweep.test.js"], "a shipped skill runs everything");
    assert.deepEqual(selectTests(["docs/x.md", "CHANGELOG.md"], { root }), [], "docs alone run no sweep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("this repo: the bridge sources select the bridge suites", () => {
  const viaServer = selectTests(["src/service/server.js"]);
  for (const t of ["test/bridge.test.js", "test/bridge-two-roots.test.js", "test/api-parity.test.js", "test/loopback-bind.test.js"]) {
    assert.ok(viaServer.includes(t), `${t} in ${JSON.stringify(viaServer)}`);
  }
  assert.ok(selectTests(["src/service/loopback.js"]).includes("test/loopback-bind.test.js"));
  assert.ok(selectTests(["bin/wicked-interactive.js"]).includes("test/serve-bridge.test.js"));
});

test("the declared check runs this script with the touched files", () => {
  const checks = JSON.parse(readFileSync(join(ROOT, ".wicked", "checks.json"), "utf8"));
  assert.deepEqual(checks.test_targeted, ["node", "scripts/test-related.mjs", "{files}"]);
});

test("the CLI: --dry-run prints the selection; nothing selected exits 0 without running", () => {
  const plan = JSON.parse(execFileSync(process.execPath, ["scripts/test-related.mjs", "--dry-run", "src/service/serve-bridge.mjs"], { cwd: ROOT, encoding: "utf8" }));
  assert.ok(plan.tests.includes("test/serve-bridge.test.js"), JSON.stringify(plan));
  const doc = `docs/unnamed-${process.pid}.md`; // built at run time, so no suite (this one included) names it
  const out = execFileSync(process.execPath, ["scripts/test-related.mjs", doc], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /nothing to run/);
});
