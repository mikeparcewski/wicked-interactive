// test-related.test.js — the change-scoped test selection behind `.wicked/checks.json`
// `test_targeted` (wicked-interactive#344): a touched source file runs the suites that import it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectTests } from "../scripts/test-related.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a bridge source file selects the bridge suites that import it", () => {
  const tests = selectTests(["src/service/loopback.js"]);
  assert.ok(tests.includes("test/loopback-bind.test.js"), JSON.stringify(tests));
  const viaServer = selectTests(["src/service/server.js"]);
  for (const t of ["test/bridge.test.js", "test/bridge-two-roots.test.js", "test/api-parity.test.js", "test/loopback-bind.test.js"]) {
    assert.ok(viaServer.includes(t), `${t} in ${JSON.stringify(viaServer)}`);
  }
  assert.ok(!viaServer.includes("test/test-related.test.js"), "a suite that does not import server.js is not selected");
});

test("a touched test runs itself; docs and unknown paths select nothing", () => {
  assert.deepEqual(selectTests(["test/serve-bridge.test.js"]), ["test/serve-bridge.test.js"]);
  assert.deepEqual(selectTests(["README.md", "docs/x.md", "frontend/src/a.js", "test/gone.test.js"]), []);
});

test("the CLI: --dry-run prints the selection; no covered file exits 0 without running", () => {
  const plan = JSON.parse(execFileSync(process.execPath, ["scripts/test-related.mjs", "--dry-run", "src/service/serve-bridge.mjs"], { cwd: ROOT, encoding: "utf8" }));
  assert.ok(plan.tests.includes("test/serve-bridge.test.js"), JSON.stringify(plan));
  const out = execFileSync(process.execPath, ["scripts/test-related.mjs", "README.md"], { cwd: ROOT, encoding: "utf8" });
  assert.match(out, /nothing to run/);
});
