// instances.test.js — the cross-instance registry behind the UI project switcher (ADR-0025).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerInstance, deregisterInstance, listInstances } from "../src/service/instances.mjs";

test("registry: register → list → re-register (no dupe) → deregister", () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-inst-"));
  const file = join(dir, "instances.json");
  try {
    assert.deepEqual(listInstances({ file }), [], "empty to start");
    registerInstance("/work/proj-a/docs", { port: 4400, pid: 111, version: "x" }, file);
    registerInstance("/work/proj-b/docs", { port: 4401, pid: 222, version: "x" }, file);
    const all = listInstances({ file });
    assert.equal(all.length, 2);
    const a = all.find((i) => i.root === "/work/proj-a/docs");
    assert.equal(a.port, 4400);
    assert.equal(a.name, "docs", "name is the root basename");

    // re-register the same root updates in place (no duplicate row)
    registerInstance("/work/proj-a/docs", { port: 4400, pid: 999, version: "y" }, file);
    assert.equal(listInstances({ file }).length, 2, "still 2 — re-register replaces");
    assert.equal(listInstances({ file }).find((i) => i.root === "/work/proj-a/docs").pid, 999);

    // isAlive filter drops dead pids (the switcher only shows live instances)
    const alive = listInstances({ file, isAlive: (pid) => pid === 999 });
    assert.deepEqual(alive.map((i) => i.root), ["/work/proj-a/docs"]);

    deregisterInstance("/work/proj-a/docs", file);
    assert.deepEqual(listInstances({ file }).map((i) => i.root), ["/work/proj-b/docs"]);
    deregisterInstance("/work/proj-a/docs", file); // idempotent — already gone
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry tolerates a missing / unreadable file (returns [])", () => {
  assert.deepEqual(listInstances({ file: join(tmpdir(), "wi-nope", "instances.json") }), []);
});
