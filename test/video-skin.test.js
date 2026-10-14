// The video follows the studio skin by default (operator 2026-10-14): crew's palette is read per render, two skins
// give two different cards, no skin gives the neutral fallback, custom colours win, and a real render's title card
// carries the skin's canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { defaultStyle, renderCut, validateStyle, loadCut } from "../src/service/demo-cut.js";
import { findFfmpeg } from "../src/service/demo.js";
import { checkedPalette, effectiveTheme, fetchSkin, NEUTRAL_PALETTE } from "../src/service/video-skin.js";

// wicked-light and wicked-dark as crew resolves them (crew src/appearance/video-palette.ts).
const LIGHT = { canvas: "#e8edf1", surface: "#ffffff", ink: "#0b0f14", ink2: "#1e262e", muted: "#38434e", line: "#dbe3e9", accent: "#224a5e", font: "Archivo", scheme: "light" };
const DARK = { canvas: "#0d1117", surface: "#1b222e", ink: "#e6edf3", ink2: "#cdd6df", muted: "#aeb9c4", line: "#2a3442", accent: "#8fc7e6", font: "Archivo", scheme: "dark" };
const skinOf = (palette) => ({ palette, source: "studio-skin", theme: palette.scheme === "light" ? "wicked-light" : "wicked-dark" });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wi-skin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, "<main><h1>Demo</h1></main>");
  mkdirSync(join(dir, "recordings"), { recursive: true });
  return dir;
}
function cut(style = defaultStyle("Tour")) {
  return { rev: 1, version: 0, chapters: [{ id: "one", title: "One", say: "Words", take: "_take-one-1.webm", inSec: 0, outSec: 2 }],
    takes: { one: [{ file: "_take-one-1.webm", durationSec: 2, at: "2026-10-14T00:00:00Z" }] }, style };
}
function encoder() {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args.includes("-filters")) return { status: 0, stderr: " ... ass V->V Render ASS subtitles\n" };
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  return { runner, calls };
}
const cardColour = (calls) => calls.find((a) => a.includes("-filter_complex")).find((x) => x.startsWith("color=c="));

test("a palette from crew is checked: #rrggbb colours, a plain font name, else none", () => {
  assert.deepEqual(checkedPalette(LIGHT), LIGHT);
  assert.equal(checkedPalette({ ...LIGHT, accent: "red" }), null);
  assert.equal(checkedPalette({ ...LIGHT, canvas: "url(x)" }), null);
  assert.equal(checkedPalette({ ...LIGHT, font: "x'); }" }).font, "system-ui");
});

test("the skin comes from crew's video-palette route; no crew, an error or a slow answer is the neutral fallback", async () => {
  const seen = [];
  const ok = await fetchSkin({ env: { WICKED_CREW_API: "http://127.0.0.1:9" }, fetchImpl: async (url) => { seen.push(url); return { ok: true, json: async () => ({ source: "studio-skin", theme: "wicked-dark", palette: DARK }) }; } });
  assert.deepEqual(seen, ["http://127.0.0.1:9/api/v1/appearance/video-palette"]);
  assert.deepEqual(ok, { palette: DARK, source: "studio-skin", theme: "wicked-dark" });
  assert.equal((await fetchSkin({ env: {} })).source, "fallback");
  assert.equal((await fetchSkin({ env: { WICKED_CREW_API: "http://x" }, fetchImpl: async () => { throw new Error("down"); } })).palette, NEUTRAL_PALETTE);
  const slow = await fetchSkin({ env: { WICKED_CREW_API: "http://x" }, timeoutMs: 20, fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  assert.equal(slow.source, "fallback");
});

test("two skins give two different cards; no skin gives the neutral fallback; custom colours win over any skin", async (t) => {
  const renders = [];
  for (const skin of [skinOf(LIGHT), skinOf(DARK), { palette: NEUTRAL_PALETTE, source: "fallback", theme: null }]) {
    const dir = fixture(t), fake = encoder();
    await renderCut(dir, cut(), { runner: fake.runner, skin });
    renders.push({ card: cardColour(fake.calls), ass: readFileSync(join(dir, "recordings", "_v1.ass"), "utf8"), record: JSON.parse(readFileSync(join(dir, "versions.json"))).versions.at(-1).render.palette });
  }
  assert.deepEqual(renders.map((r) => r.card.slice(0, 16)), ["color=c=0xE8EDF1", "color=c=0x0D1117", "color=c=0x16181D"]);
  assert.notEqual(renders[0].ass.match(/^Style: Caption.*$/m)[0], renders[1].ass.match(/^Style: Caption.*$/m)[0]);
  assert.match(renders[0].ass, /^Style: Caption,Archivo,/m);
  assert.deepEqual(renders.map((r) => r.record.source), ["studio-skin", "studio-skin", "fallback"]);
  // A custom style keeps its own colours whatever the skin, and is never fetched for.
  const dir = fixture(t), fake = encoder();
  const custom = validateStyle({ theme: { background: "#336699" } }, "Tour");
  assert.equal(custom.theme.palette, "custom");
  await renderCut(dir, cut(custom), { runner: fake.runner, fetchSkin: async () => { throw new Error("must not fetch"); } });
  assert.ok(cardColour(fake.calls).startsWith("color=c=0x336699"));
  // The stored cut keeps the choice, not the resolved colours.
  assert.equal(loadCut(dir).style.theme.palette, "custom");
});

test("a style stored before `palette` existed reads as following the skin, and can be switched", () => {
  const legacy = defaultStyle("Tour");
  delete legacy.theme.palette;
  assert.equal(validateStyle({}, "Tour", legacy).theme.palette, "skin");
  assert.equal(validateStyle({ theme: { palette: "custom" } }, "Tour", legacy).theme.palette, "custom");
  assert.throws(() => validateStyle({ theme: { palette: "neon" } }), (e) => e.payload.field === "style.theme.palette");
  assert.equal(effectiveTheme(defaultStyle("Tour").theme, skinOf(DARK)).background, DARK.canvas);
});

test("GET /api/demo/cut reports the skin and the colours the next render uses", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "demo-cut.json"), JSON.stringify(cut()));
  const svc = createServer({ dir, demoCut: { runner: encoder().runner, fetchSkin: async () => skinOf(DARK) } });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  const body = await (await fetch(`http://localhost:${port}/api/demo/cut`)).json();
  assert.deepEqual(body.skin, { source: "studio-skin", theme: "wicked-dark", palette: DARK });
  assert.equal(body.resolvedTheme.background, DARK.canvas);
  assert.equal(body.style.theme.palette, "skin");
});

const ffmpeg = findFfmpeg();
test("real ffmpeg: a light and a dark skin give title cards in their own canvas colours", { skip: !ffmpeg && "ffmpeg unavailable", timeout: 180_000 }, async (t) => {
  const pixel = (file, at) => {
    const r = spawnSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "crop=8:8:0:0,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60_000 });
    assert.equal(r.status, 0, String(r.stderr));
    return [...r.stdout.subarray(0, 3)];
  };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const palette of [LIGHT, DARK]) {
    const dir = fixture(t);
    const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=2", "-c:v", "libvpx-vp9", "-threads", "2", "-pix_fmt", "yuv420p", join(dir, "recordings", "_take-one-1.webm")], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const { version } = await renderCut(dir, cut(), { ffmpegPath: ffmpeg, skin: skinOf(palette) });
    const got = pixel(join(dir, "recordings", `_v${version}.mp4`), 0.5);
    const want = hex(palette.canvas);
    assert.ok(got.every((c, i) => Math.abs(c - want[i]) <= 12), `title card ${got} vs skin canvas ${want}`);
    // Frames to look at: the title card of each skin.
    const out = process.env.WI_SKIN_FRAMES;
    if (out) spawnSync(ffmpeg, ["-y", "-v", "error", "-ss", "1.2", "-i", join(dir, "recordings", `_v${version}.mp4`), "-frames:v", "1", join(out, `skin-${palette.scheme}-title.png`)]);
  }
});
