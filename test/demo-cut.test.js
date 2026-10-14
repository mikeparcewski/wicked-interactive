import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { initWorkspace } from "../src/service/workspace.js";
import { createServer } from "../src/service/server.js";
import { recordDemo, findFfmpeg } from "../src/service/demo.js";
import { defaultStyle, validateStyle, validateRecut, chapterIds, writeAss, writeVtt, captionEvents,
  renderCut, loadCut, ffmpegCapabilities, extractTakes } from "../src/service/demo-cut.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "wi-cut-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initWorkspace(dir, "<h1>Tour</h1>", { kind: "demo" });
  mkdirSync(join(dir, "recordings"));
  return dir;
}
function sample() {
  return { rev: 1, version: 0, chapters: [
    { id: "one", title: "One", say: "First words describe the action and why this matters to a viewer with more words to read", take: "_take-one-1.webm", inSec: 0, outSec: 4 },
    { id: "two", title: "Two", say: "Second caption", take: "_take-two-1.webm", inSec: 1, outSec: 3 },
  ], takes: {
    one: [{ file: "_take-one-1.webm", durationSec: 4, at: "2026-10-14T00:00:00Z" }, { file: "_take-one-2.webm", durationSec: 6, at: "2026-10-14T00:00:01Z" }],
    two: [{ file: "_take-two-1.webm", durationSec: 4, at: "2026-10-14T00:00:00Z" }],
  }, style: defaultStyle("Tour") };
}
function encoder(ass = true) {
  const calls = [];
  const runner = (args, opts = {}) => {
    calls.push(args);
    calls.cwds = [...(calls.cwds ?? []), opts.cwd];
    if (args.includes("-filters")) return { status: 0, stderr: ass ? " ... ass V->V Render ASS subtitles\n" : " ... scale V->V Scale\n" };
    writeFileSync(args.at(-1), "encoded");
    return { status: 0, stderr: "" };
  };
  return { runner, calls };
}
function errorField(fn, field) {
  assert.throws(fn, (e) => e.status === 400 && e.payload.field === field);
}

test("chapter slugs are stable and unique even when labels collide with suffixed labels", async () => {
  assert.deepEqual(chapterIds(["Open the scope", "Open the scope", "Open the scope", "Open the scope 2", "!!", "é"]),
    ["open-the-scope", "open-the-scope-2", "open-the-scope-3", "open-the-scope-2-2", "chapter", "e"]);
});
test("style defaults and every caption bound", async () => {
  assert.deepEqual(validateStyle({}), defaultStyle());
  for (const [key, low, high] of [["size", 18, 72], ["maxLines", 1, 3], ["wrapChars", 20, 80]]) {
    for (const v of [low, high]) assert.equal(validateStyle({ captions: { [key]: v } }).captions[key], v);
    for (const v of [low - 1, high + 1, "36", null, NaN, Infinity]) {
      errorField(() => validateStyle({ captions: { [key]: v } }), `style.captions.${key}`);
    }
    if (key !== "size") errorField(() => validateStyle({ captions: { [key]: low + 0.5 } }), `style.captions.${key}`);
  }
});
test("style is closed at every level and validates cards, enums, fonts, colours and strings", async () => {
  for (const [style, field] of [
    [{ extra: 1 }, "style.extra"], [{ theme: { extra: 1 } }, "style.theme.extra"],
    [{ captions: { extra: 1 } }, "style.captions.extra"], [{ theme: { titleCard: { extra: 1 } } }, "style.theme.titleCard.extra"],
    [{ theme: { endCard: { extra: 1 } } }, "style.theme.endCard.extra"],
    [{ captions: { on: 1 } }, "style.captions.on"], [{ captions: { burnIn: "yes" } }, "style.captions.burnIn"],
    [{ captions: { position: "left" } }, "style.captions.position"], [{ captions: { style: "box" } }, "style.captions.style"],
    [{ theme: { font: "Arial" } }, "style.theme.font"], [{ theme: { background: "red;bad" } }, "style.theme.background"],
  ]) errorField(() => validateStyle(style), field);
  for (const card of ["titleCard", "endCard"]) {
    for (const seconds of [0, -1, 0.4, 10.5, NaN, Infinity, "2.5"]) errorField(() => validateStyle({ theme: { [card]: { seconds } } }), `style.theme.${card}.seconds`);
    for (const key of ["title", "subtitle"]) {
      assert.equal(validateStyle({ theme: { [card]: { [key]: "x".repeat(80) } } }).theme[card][key].length, 80);
      for (const v of ["x".repeat(81), "line\nbreak", "line\rbreak", 12]) errorField(() => validateStyle({ theme: { [card]: { [key]: v } } }), `style.theme.${card}.${key}`);
    }
    errorField(() => validateStyle({ theme: { [card]: { on: "on" } } }), `style.theme.${card}.on`);
    assert.equal(validateStyle({ theme: { [card]: { seconds: 0.5, on: false } } }).theme[card].seconds, 0.5);
  }
  for (const color of ["#abc", "#aabbcc", "#aabbccff", "rgb(10,20,30)", "rgba(10,20,30,0.5)", "hsl(120,50%,40%)", "var(--wi-accent)"]) {
    for (const key of ["background", "foreground", "accent"]) assert.equal(validateStyle({ theme: { [key]: color } }).theme[key], color);
  }
  for (const font of ["Inter", "Roboto", "Source Sans 3", "IBM Plex Sans", "system-ui"]) assert.equal(validateStyle({ theme: { font } }).theme.font, font);
  for (const v of [null, [], 4]) errorField(() => validateStyle(v), "style");
});
test("recut reorders, renames, selects takes and trims without changing narration or its input", async () => {
  const cut = sample(), before = structuredClone(cut);
  const edited = validateRecut(cut, { rev: 1, chapters: [{ id: "two", title: "New title" }, { id: "one", take: "_take-one-2.webm", inSec: 2, outSec: 5 }], style: { captions: { size: 48 } } });
  assert.deepEqual(edited.chapters.map((c) => c.id), ["two", "one"]);
  assert.equal(edited.chapters[0].say, cut.chapters[1].say);
  assert.equal(edited.style.captions.size, 48);
  assert.deepEqual(cut, before);
});
test("recut refuses dropped, added, duplicate and foreign chapter ids, takes and invalid trims", async () => {
  const cut = sample();
  for (const chapters of [[{ id: "one" }], [{ id: "one" }, { id: "two" }, { id: "three" }], [{ id: "one" }, { id: "one" }], [{ id: "one" }, { id: "three" }]]) {
    assert.throws(() => validateRecut(cut, { rev: 1, chapters }), (e) => e.status === 400);
  }
  for (const entry of [{ take: "_take-two-1.webm" }, { take: "../outside.webm" }, { inSec: -1 }, { inSec: 4 }, { outSec: 5 }, { outSec: 0.49 }, { inSec: "0" }, { outSec: null }]) {
    assert.throws(() => validateRecut(cut, { rev: 1, chapters: [{ id: "one", ...entry }, { id: "two" }] }), (e) => e.status === 400);
  }
  assert.equal(validateRecut(cut, { rev: 1, chapters: [{ id: "one", inSec: 3.5 }, { id: "two" }] }).chapters[0].inSec, 3.5);
  assert.throws(() => validateRecut(cut, { rev: 0, chapters: [] }), (e) => e.status === 409 && e.payload.rev === 1 && e.payload.error === "rev_moved");
});
test("ASS and VTT split wrapped overflow into consecutive events in the stitched chapter window", async () => {
  const cut = sample();
  cut.style.captions = { ...cut.style.captions, wrapChars: 20, maxLines: 2, position: "top", size: 48 };
  const events = captionEvents(cut), first = events.filter((e) => e.style === "Caption" && e.start < 6.5);
  assert.ok(first.length > 1);
  assert.equal(first[0].start, 2.5);
  assert.equal(first.at(-1).end, 6.5);
  for (const [i, e] of first.entries()) {
    assert.ok(e.lines.length <= 2);
    assert.ok(e.lines.every((l) => l.length <= 20));
    if (i) assert.equal(e.start, first[i - 1].end);
  }
  const ass = writeAss(cut), vtt = writeVtt(cut);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Style: Caption,Inter,48,&H00FFFFFF,&H00B29108/);
  assert.match(ass, /,3,12,0,8,64,64,48,1/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:02.50,Card/);
  assert.match(ass, /Dialogue: 0,0:00:08.50,0:00:11.00,Card/);
  assert.match(ass, /\\N/);
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.match(vtt, /00:00:08.500 --> 00:00:11.000/);
  assert.equal((ass.match(/^Dialogue:/gm) || []).length, (vtt.match(/ --> /g) || []).length);
  cut.style.captions.on = false;
  assert.equal(captionEvents(cut).length, 2);
});
test("ASS handles outline/plain styles and treats narrated override text as literal", async () => {
  const cut = sample();
  cut.chapters[0].say = "{\\pos(0,0)} caption <tag>";
  cut.style.captions.style = "outline";
  assert.match(writeAss(cut), /,1,2,0,2,64,64,48,1/);
  assert.match(writeAss(cut), /\\\{/);
  assert.match(writeVtt(cut), /&lt;tag&gt;/);
  cut.style.captions.style = "plain";
  assert.match(writeAss(cut), /,1,0,0,2,64,64,48,1/);
});
for (const ass of [true, false]) test(`render args, sidecars, lineage and burn-in when ass filter = ${ass}`, async (t) => {
  const dir = fixture(t), fake = encoder(ass), cut = sample();
  const result = await renderCut(dir, cut, { runner: fake.runner, documentId: "tour" });
  assert.equal(result.version, 1);
  assert.equal(result.rev, 2);
  const args = fake.calls.find((a) => a.includes("-filter_complex")), filter = args[args.indexOf("-filter_complex") + 1];
  assert.equal(filter.includes("ass=_v"), ass);
  assert.match(filter, /scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
  assert.match(filter, /concat=n=4:v=1:a=0/);
  assert.ok(args.includes("color=c=0x0B1020:s=1920x1080:d=2.5:r=30"));
  assert.ok(args.includes("-ss") && args.includes("-to"));
  assert.ok(args.includes("libx264") && args.includes("yuv420p") && args.includes("+faststart"));
  for (const suffix of ["mp4", "ass", "vtt", "html"]) assert.ok(existsSync(join(suffix === "html" ? dir : join(dir, "recordings"), `_v1.${suffix}`)));
  assert.ok(existsSync(join(dir, "recordings", "_v1-poster.jpg")));
  const manifest = JSON.parse(readFileSync(join(dir, "versions.json")));
  assert.equal(manifest.versions[1].parent, 0);
  assert.equal(manifest.versions[1].render.burnIn, ass ? true : "unavailable");
  assert.match(readFileSync(join(dir, "_v1.html"), "utf8"), /data-seek="6.5"/);
  assert.deepEqual(await ffmpegCapabilities({ runner: fake.runner }), { ok: true, burnIn: ass });
  assert.equal(fake.calls.filter((a) => a.includes("-filters")).length, 1);
  const saved = loadCut(dir);
  await renderCut(dir, { ...saved, style: validateStyle({ captions: { burnIn: false } }, "Tour", saved.style) }, { runner: fake.runner });
  // Caption burn-in off: the overlay still carries the title and end cards' text, and no caption.
  const nextArgs = fake.calls.filter((a) => a.includes("-filter_complex")).at(-1);
  assert.equal(nextArgs[nextArgs.indexOf("-filter_complex") + 1].includes("ass=_v2.ass"), ass);
  assert.ok(!readFileSync(join(dir, "recordings", "_v2.ass"), "utf8").includes(",Caption,"));
});
test("missing ffmpeg and failed encodes do not land a version or overwrite the cut", async (t) => {
  const dir = fixture(t);
  await assert.rejects(() => renderCut(dir, sample(), { ffmpegPath: null }), (e) => e.payload.error === "ffmpeg_missing" && /Install/.test(e.payload.hint));
  assert.deepEqual(await ffmpegCapabilities({ ffmpegPath: null }), { ok: false, burnIn: false });
  await assert.rejects(() => renderCut(dir, sample(), { runner: () => ({ status: 1, stderr: "encode failed" }) }), /ffmpeg_failed/);
  assert.equal(JSON.parse(readFileSync(join(dir, "versions.json"))).head, 0);
  assert.ok(!existsSync(join(dir, "demo-cut.json")));
});
test("chapter-only takes preserve the other chapters and re-encode both formats", async (t) => {
  const dir = fixture(t), cut = sample(), fake = encoder();
  writeFileSync(join(dir, "demo-cut.json"), JSON.stringify(cut));
  writeFileSync(join(dir, "recordings", "_take-one-1.webm"), "old");
  writeFileSync(join(dir, "recordings", "_take-one-2.webm"), "old2");
  const result = await extractTakes(dir, "run.webm", [{ label: "One", say: "New narration", at: 0 }, { label: "Two", say: "Two words", at: 2 }], 4, { title: "Tour" }, { runner: fake.runner, chapter: "one" });
  assert.deepEqual(result.takes, [{ chapter: "one", file: "_take-one-3.webm", durationSec: 2 }]);
  assert.deepEqual(loadCut(dir).chapters[1], cut.chapters[1]);
  assert.equal(loadCut(dir).takes.one.length, 3);
  assert.equal(loadCut(dir).chapters[0].say, "New narration");
  assert.ok(fake.calls.some((a) => a.includes("libvpx-vp9")));
  assert.ok(!fake.calls.some((a) => a.includes("copy")));
});

test("a full take of a re-authored spec starts a new cut; a one-chapter take of it is refused", async (t) => {
  const dir = fixture(t), cut = sample(), fake = encoder();
  writeFileSync(join(dir, "demo-cut.json"), JSON.stringify({ ...cut, style: { ...cut.style, captions: { ...cut.style.captions, size: 48 } } }));
  const steps = [{ label: "Open", say: "", at: 0 }, { label: "Close", say: "", at: 2 }];
  await assert.rejects(() => extractTakes(dir, "run.webm", steps, 4, {}, { runner: fake.runner, chapter: "one" }), (e) => e.payload.field === "chapters");
  const result = await extractTakes(dir, "run.webm", steps, 4, {}, { runner: fake.runner });
  const saved = loadCut(dir);
  assert.deepEqual(saved.chapters.map((c) => c.id), ["open", "close"]);
  assert.deepEqual(Object.keys(saved.takes), ["open", "close"]);
  assert.equal(saved.style.captions.size, 48);
  assert.equal(saved.rev, cut.rev + 1);
  assert.equal(result.takes.length, 2);
});

test("recordDemo takes uses one browser run and records narration without DOM captions", async (t) => {
  const dir = fixture(t), fake = encoder(), seen = { launch: 0, close: 0, evaluate: 0 };
  writeFileSync(join(dir, "demo.spec.mjs"), `export const meta = {title:'Tour'}; export async function run({step}) { await step('One', async () => {}, {say:'Narration', holdMs:0}); await step('Two', async () => {}, {say:'More words', holdMs:0}); }`);
  const raw = join(dir, "recordings", "raw.webm");
  const page = {
    evaluate: async () => { seen.evaluate++; }, screenshot: async () => {},
    waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: async () => {}, video: () => ({ path: async () => raw }),
  };
  const context = { route: async () => {}, routeWebSocket: async () => {}, newPage: async () => page,
    tracing: { start: async () => {}, stop: async () => {} }, close: async () => { seen.close++; writeFileSync(raw, "recording"); } };
  const importPlaywright = async () => ({ chromium: { launch: async () => { seen.launch++; return { newContext: async () => context, close: async () => {} }; } } });
  const result = await recordDemo(dir, { takes: true, runner: fake.runner, importPlaywright, documentId: "tour" });
  assert.equal(seen.launch, 1);
  assert.equal(seen.close, 1);
  assert.equal(seen.evaluate, 0);
  assert.equal(result.takes.length, 2);
  assert.ok(result.takes.every((take) => take.durationSec >= 0.5));
  assert.equal(loadCut(dir).chapters[0].say, "Narration");
});

test("demo cut routes validate, queue revisions, land versions, and return typed recorder failures", async (t) => {
  const dir = fixture(t), fake = encoder(), events = [];
  let fail = false, lastOpts;
  const record = async (d, opts) => {
    lastOpts = opts;
    if (fail) throw new Error("no demo.spec.mjs authored yet");
    return extractTakes(d, "run.webm", [{ label: "One", say: "First", at: 0 }, { label: "Two", say: "Second", at: 2 }], 4, { title: "Tour" }, opts);
  };
  const svc = createServer({ dir, documentId: "tour", emit: (type, payload) => events.push({ type, payload }), demoCut: { runner: fake.runner, record } });
  const port = await svc.start(0), base = `http://localhost:${port}`;
  t.after(() => svc.stop());
  const req = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  assert.deepEqual(await req("GET", "/api/demo/cut"), { status: 404, body: { error: "no_cut" } });
  const takes = await req("POST", "/api/demo/takes", {});
  assert.equal(takes.status, 200);
  assert.equal(takes.body.takes.length, 2);
  assert.equal(lastOpts.takes, true);
  const get = await req("GET", "/api/demo/cut");
  assert.deepEqual(get.body.ffmpeg, { ok: true, burnIn: true });
  assert.equal(get.body.rev, 1);
  const recut = await req("POST", "/api/demo/recut", { rev: 1, chapters: [{ id: "two" }, { id: "one", inSec: 0.5 }] });
  assert.deepEqual(recut, { status: 200, body: { rev: 2, version: 2 } });
  const stale = await req("PUT", "/api/demo/style", { rev: 1, style: {} });
  assert.deepEqual(stale, { status: 409, body: { error: "rev_moved", rev: 2 } });
  const responses = await Promise.all([req("PUT", "/api/demo/style", { rev: 2, style: { captions: { size: 48 } } }), req("PUT", "/api/demo/style", { rev: 2, style: {} })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const bad = await req("PUT", "/api/demo/style", { rev: 3, style: { surprise: true } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "style.surprise");
  assert.equal((await req("POST", "/api/demo/takes", { chapter: "unknown" })).status, 400);
  fail = true;
  const failed = await req("POST", "/api/demo/takes", {});
  assert.equal(failed.status, 400);
  assert.ok(failed.body.error);
  assert.ok(failed.body.remedy);
  // Announced in the bus's own vocabulary (an unknown type would reject inside the service's emit).
  const landed = events.filter((e) => e.type === "wicked.interactive.version.created");
  assert.equal(landed.length, 3);
  assert.ok(landed.every((e) => e.payload.kind === "demo" && e.payload.html_file === `_v${e.payload.version}.html`));
  assert.equal((await fetch(base + "/api/demo/recording/_v1.vtt")).headers.get("content-type"), "text/vtt");
});
test("a theme variable that is not a colour is refused, the default title is one clean line, the target url survives a re-cut", async (t) => {
  const dir = fixture(t), fake = encoder();
  const cut = sample();
  const notColour = validateStyle({ theme: { background: "var(--wi-font-body)" } });
  await assert.rejects(() => renderCut(dir, { ...cut, style: notColour }, { runner: fake.runner }), (e) => e.payload.error === "unresolved_color");
  assert.equal(defaultStyle("Line one\nline two " + "x".repeat(100)).theme.titleCard.title.length, 80);
  assert.ok(!/[\r\n]/.test(defaultStyle("a\r\nb").theme.titleCard.title));
  const steps = [{ label: "One", say: "", at: 0 }, { label: "Two", say: "", at: 2 }];
  await extractTakes(dir, "run.webm", steps, 4, { url: "http://127.0.0.1:5173/app" }, { runner: fake.runner });
  const saved = loadCut(dir);
  assert.equal(saved.url, "http://127.0.0.1:5173/app");
  const { version } = await renderCut(dir, validateRecut(saved, { rev: saved.rev, chapters: [{ id: "two" }, { id: "one" }] }), { runner: fake.runner });
  assert.ok(readFileSync(join(dir, `_v${version}.html`), "utf8").includes("http://127.0.0.1:5173/app"));
});
test("author text never becomes an ASS escape, a Constructor chapter records, long labels make bounded slugs, ffmpeg runs in the recordings dir", async (t) => {
  const dir = fixture(t), fake = encoder();
  const cut = sample();
  cut.chapters[0].say = "Type A\\NB then \\h and {\\b1}";
  const ass = writeAss(cut);
  const dialogue = ass.split("\n").find((l) => l.includes("Type A"));
  assert.ok(!/\\[Nnh]/.test(dialogue.replace(/\\N(?=[^\u2060])/g, "")), dialogue);
  assert.ok(dialogue.includes("\\\u2060N") && dialogue.includes("\\{"));
  const long = "x".repeat(300);
  const ids = chapterIds([long, long, "Constructor"]);
  assert.ok(ids.every((id) => id.length <= 43));
  assert.notEqual(ids[0], ids[1]);
  const steps = [{ label: "Constructor", say: "", at: 0 }, { label: "toString", say: "", at: 2 }];
  const result = await extractTakes(dir, "run.webm", steps, 4, {}, { runner: fake.runner });
  assert.deepEqual(result.takes.map((x) => x.chapter), ["constructor", "tostring"]);
  assert.ok(Array.isArray(loadCut(dir).takes.constructor));
  assert.ok(fake.calls.cwds.filter(Boolean).every((c) => c === join(dir, "recordings")));
});
test("colour aliases resolve and cycles refuse; card text burns with captions off; a reserved version number is skipped", async (t) => {
  const dir = fixture(t), fake = encoder(), cut = sample();
  const aliased = { ...cut, style: validateStyle({ theme: { background: "var(--wi-bg)" } }, "Tour", cut.style) };
  const vars = { "--wi-bg": "var(--wi-accent)", "--wi-accent": "#112233" };
  assert.match(writeAss(aliased, vars), /&H00332211/);
  assert.throws(() => writeAss(aliased, { "--wi-bg": "var(--wi-accent)", "--wi-accent": "var(--wi-bg)" }), (e) => e.payload.error === "unresolved_color");
  const quiet = { ...cut, style: validateStyle({ captions: { burnIn: false } }, "Tour", cut.style) };
  const ass = writeAss(quiet, {}, { captions: false });
  assert.ok(ass.includes(",Card,") && !ass.includes(",Caption,"));
  writeFileSync(join(dir, "_v5.md"), "---\nversion: 5\n---\n");
  const r = await renderCut(dir, quiet, { runner: fake.runner });
  assert.equal(r.version, 6);
  const filter = fake.calls.find((a) => a.includes("-filter_complex"));
  assert.ok(filter[filter.indexOf("-filter_complex") + 1].includes("ass=_v6.ass"), "card text still burned");
  assert.equal(JSON.parse(readFileSync(join(dir, "versions.json"))).versions.at(-1).render.cardText, true);
});
test("mutating cut routes all report ffmpeg_missing with an install hint", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "demo-cut.json"), JSON.stringify(sample()));
  const svc = createServer({ dir, demoCut: { ffmpegPath: null } });
  const port = await svc.start(0);
  t.after(() => svc.stop());
  for (const [method, route, body] of [["POST", "takes", {}], ["POST", "recut", { rev: 1, chapters: [{ id: "one" }, { id: "two" }] }], ["PUT", "style", { rev: 1, style: {} }]]) {
    const r = await fetch(`http://localhost:${port}/api/demo/${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(r.status, 400);
    const result = await r.json();
    assert.equal(result.error, "ffmpeg_missing");
    assert.match(result.hint, /Install ffmpeg/);
  }
});

const ffmpeg = findFfmpeg();
test("real ffmpeg: reorder and trim distinct takes, check order by colour, the MP4 duration and the GIF export", { skip: !ffmpeg && "ffmpeg unavailable", timeout: 180_000 }, async (t) => {
  const dir = fixture(t), cut = sample();
  // Chapter one is solid red, chapter two solid blue: the rendered order is read back from the pixels.
  for (const [chapter, colour] of cut.chapters.map((c, i) => [c, i === 0 ? "red" : "blue"])) {
    const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=30:d=4`, "-c:v", "libvpx-vp9", "-threads", "2", "-pix_fmt", "yuv420p", join(dir, "recordings", chapter.take)], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  }
  const pixel = (file, at) => {
    const r = spawnSync(ffmpeg, ["-v", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60_000 });
    assert.equal(r.status, 0, String(r.stderr));
    return [...r.stdout.subarray(0, 3)];
  };
  const edited = validateRecut(cut, { rev: 1, chapters: [{ id: "two", inSec: 0.5, outSec: 2 }, { id: "one", inSec: 1, outSec: 3 }], style: { theme: { titleCard: { seconds: 0.5 }, endCard: { seconds: 0.5 } } } });
  const result = await renderCut(dir, edited, { ffmpegPath: ffmpeg, documentId: "tour" });
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", join(dir, "recordings", `_v${result.version}.mp4`)], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Math.abs(Number(probe.stdout) - 4.5) <= 0.3, `duration ${probe.stdout}`);
  // 0.5 s title card, then chapter two (1.5 s, blue), then chapter one (2 s, red), then the end card.
  const mp4 = join(dir, "recordings", `_v${result.version}.mp4`);
  const [, , blueish] = pixel(mp4, 1.2);
  const [redish] = pixel(mp4, 2.9);
  assert.ok(blueish > 150, `chapter two (blue) first: ${blueish}`);
  assert.ok(redish > 150, `chapter one (red) second: ${redish}`);
  // A rendered cut lands only an MP4; the GIF export reads it.
  const { exportGif } = await import("../src/service/demo.js");
  const out = exportGif(dir, result.version, { ffmpegPath: ffmpeg, fps: 5, width: 160 });
  assert.ok(out.bytes > 0 && existsSync(out.path));
});
