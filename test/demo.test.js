import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportGif, storyboard, DEFAULT_HOLD_MS, CAPTION_HOLD_CAP_MS } from "../src/service/demo.js";

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


// ── storyboard: the player the studio embeds serves the mp4 + poster it already produced (#211) ──

test("storyboard emits the poster and an mp4-first <source> list when both exist (the player route's shape)", () => {
  const html = storyboard({ documentId: "tour", title: "Tour", url: "http://app.test/", videoFile: "_v1.webm", mp4File: "_v1.mp4", posterFile: "_v1-poster.jpg", steps: [] });
  const video = /<video[^>]*>[\s\S]*?<\/video>/.exec(html)?.[0];
  assert.ok(video, "one <video> element");
  assert.match(video, /poster="\/d\/tour\/api\/demo\/recording\/_v1-poster\.jpg"/);
  const sources = [...video.matchAll(/<source src="([^"]+)" type="([^"]+)">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sources, [
    ["/d/tour/api/demo/recording/_v1.mp4", "video/mp4"],
    ["/d/tour/api/demo/recording/_v1.webm", "video/webm"],
  ], "h264 first, webm second");
  assert.doesNotMatch(video, /<video[^>]*\ssrc=/, "no webm-only src attribute (it would double-fetch past the sources)");
});

test("storyboard without an mp4/poster (no ffmpeg) is webm-only with no poster attribute — exactly the old rendering", () => {
  const html = storyboard({ documentId: "tour", title: "Tour", url: "http://app.test/", videoFile: "_v2.webm", steps: [] });
  const video = /<video[^>]*>[\s\S]*?<\/video>/.exec(html)?.[0];
  assert.doesNotMatch(video, /poster=/);
  const sources = [...video.matchAll(/<source src="([^"]+)" type="([^"]+)">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sources, [["/d/tour/api/demo/recording/_v2.webm", "video/webm"]]);
});

test("caption holds: the default read-pause is under the cap, and the cap is what every hold is clamped to (#211)", () => {
  assert.ok(DEFAULT_HOLD_MS <= CAPTION_HOLD_CAP_MS);
  assert.ok(CAPTION_HOLD_CAP_MS <= 3000, "a static hold longer than 3 s per step is the half-frozen clip the issue measured");
});
