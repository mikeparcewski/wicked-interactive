import { test } from "node:test";
import assert from "node:assert/strict";
import { initManifest, addVersion, fork, ancestry, allVersions, getVersion } from "../src/core/versions.js";

test("init seeds version 0 as head", () => {
  const m = initManifest();
  assert.equal(m.head, 0);
  assert.equal(m.versions.length, 1);
  assert.equal(m.versions[0].parent, null);
  assert.equal(m.versions[0].html_file, "_v0.html");
});

test("addVersion increments monotonically and advances head", () => {
  let m = initManifest();
  ({ manifest: m } = addVersion(m, { feedbackFile: "_v1.md" }));
  assert.equal(m.head, 1);
  assert.equal(getVersion(m, 1).parent, 0);
  assert.equal(getVersion(m, 1).feedback_file, "_v1.md");
});

test("write-once (INV-4): addVersion does not mutate the prior manifest", () => {
  const m0 = initManifest();
  const before = JSON.stringify(m0);
  addVersion(m0, { feedbackFile: "_v1.md" });
  assert.equal(JSON.stringify(m0), before, "input manifest must be untouched");
});

test("fork is non-destructive (AC-21/AC-22): old versions remain, new head points at the fork source", () => {
  let m = initManifest();
  ({ manifest: m } = addVersion(m, { feedbackFile: "_v1.md" })); // v1 (parent 0), head=1
  ({ manifest: m } = addVersion(m, { feedbackFile: "_v2.md" })); // v2 (parent 1), head=2
  const { manifest: forked, version } = fork(m, 0);              // fork from v0
  assert.equal(version, 3, "monotonic numbering continues across forks");
  assert.equal(forked.head, 3);
  assert.equal(getVersion(forked, 3).parent, 0);
  // nothing lost:
  assert.deepEqual(allVersions(forked).map((v) => v.version), [0, 1, 2, 3]);
});

test("ancestry walks parent pointers to the root", () => {
  let m = initManifest();
  ({ manifest: m } = addVersion(m, {}));      // v1 <- 0
  ({ manifest: m } = addVersion(m, {}));      // v2 <- 1
  ({ manifest: m } = fork(m, 0));             // v3 <- 0
  assert.deepEqual(ancestry(m, 2), [0, 1, 2]);
  assert.deepEqual(ancestry(m, 3), [0, 3], "a fork's ancestry skips the other branch");
});

test("addVersion from a non-existent parent throws", () => {
  assert.throws(() => addVersion(initManifest(), { parent: 99 }), /does not exist/);
});
