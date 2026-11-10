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

/** A throwaway repo root with the given test files (name → body). */
function fixture(suites) {
  const root = mkdtempSync(join(tmpdir(), "wi-test-related-"));
  mkdirSync(join(root, "test"));
  for (const [name, body] of Object.entries(suites)) writeFileSync(join(root, "test", name), body);
  return root;
}

test("selection: imports, spawned entry points and data files select the suites that name them", () => {
  const root = fixture({
    "a.test.js": `import { x } from "../src/service/server.js";`,
    "b.test.js": `const cli = join(HERE, "..", "bin", "wicked-interactive.js");`,
    "c.test.js": "const s = readFileSync(`../src/service/event-schemas/doc.created.json`);",
    "d.test.js": `import { y } from "../src/service/not-server.js"; // server.js in a comment only`,
  });
  try {
    assert.deepEqual(selectTests(["src/service/server.js"], { root }), ["test/a.test.js"]);
    assert.deepEqual(selectTests(["bin/wicked-interactive.js"], { root }), ["test/b.test.js"]);
    assert.deepEqual(selectTests(["src/service/event-schemas/doc.created.json"], { root }), ["test/c.test.js"]);
    assert.deepEqual(selectTests(["test/d.test.js", "test/gone.test.js"], { root }), ["test/d.test.js"], "a touched suite runs itself; a deleted one is dropped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selection: an unnamed source file runs every suite; an unnamed doc runs none", () => {
  const root = fixture({ "a.test.js": `import "../src/a.js";`, "b.test.js": `import "../src/b.js";` });
  try {
    const all = ["test/a.test.js", "test/b.test.js"];
    for (const f of ["src/service/orphan.js", "src/x.json", "bin/other.js", "scripts/tool.mjs", ".wicked/checks.json", "package.json", "test/helper.mjs"]) {
      assert.deepEqual(selectTests([f], { root }), all, f);
    }
    assert.deepEqual(selectTests(["README.md", "docs/x.md", "site/index.astro"], { root }), []);
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
