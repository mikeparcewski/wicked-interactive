import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportGif } from "../src/service/demo.js";

function workspaceWithRecording(version = 1, webmBytes = "fake-webm-bytes") {
  const dir = mkdtempSync(join(tmpdir(), "wi-gif-"));
  const recDir = join(dir, "recordings");
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, `_v${version}.webm`), webmBytes);
  return { dir, recDir };
}

// A stand-in for ffmpeg so the test never needs the real binary (mirrors the injectable
// PDF renderer in export.js). The call count lives on `.state` (a holder object, not a getter
// — Object.assign would invoke a getter and copy its value, freezing the count at 0).
function fakeEncoder() {
  const state = { calls: 0 };
  const fn = (webmPath, gifPath) => {
    state.calls += 1;
    assert.ok(existsSync(webmPath), "encoder receives an existing source webm");
    writeFileSync(gifPath, "GIF89a-fake-bytes");
  };
  fn.state = state;
  return fn;
}

test("exportGif encodes a version's webm into a cached .gif", () => {
  const { dir, recDir } = workspaceWithRecording(1);
  const encoder = fakeEncoder();

  const first = exportGif(dir, 1, { encoder });
  assert.equal(first.cached, false);
  assert.equal(first.path, join(recDir, "_v1.gif"));
  assert.ok(first.bytes > 0);
  assert.ok(existsSync(first.path));
  assert.equal(encoder.state.calls, 1);
});

test("exportGif returns the cache on a second call (no re-encode)", () => {
  const { dir } = workspaceWithRecording(1);
  const encoder = fakeEncoder();

  exportGif(dir, 1, { encoder });
  const second = exportGif(dir, 1, { encoder });
  assert.equal(second.cached, true);
  assert.equal(encoder.state.calls, 1, "encoder runs once; the second call is served from cache");
});

test("exportGif re-encodes when the source webm is newer than the cached gif", () => {
  const { dir, recDir } = workspaceWithRecording(1);
  const encoder = fakeEncoder();

  exportGif(dir, 1, { encoder });            // produces _v1.gif
  // Make the source webm newer than the gif (a re-record supersedes the cache).
  const gifMtime = statSync(join(recDir, "_v1.gif")).mtimeMs / 1000;
  const newer = gifMtime + 10;
  utimesSync(join(recDir, "_v1.webm"), newer, newer);

  const again = exportGif(dir, 1, { encoder });
  assert.equal(again.cached, false);
  assert.equal(encoder.state.calls, 2, "a newer webm forces a fresh encode");
});

test("exportGif throws a clear error when the version was never recorded", () => {
  const { dir } = workspaceWithRecording(1);
  assert.throws(() => exportGif(dir, 9, { encoder: fakeEncoder() }), /no recording for v9/);
});
