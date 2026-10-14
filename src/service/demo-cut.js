// Chapter takes and write-once renders of the current edit decision list.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isColor } from "../core/theme-grammar.js";
import { instrument } from "../core/instrument.js";
import { themeCss } from "../core/theme.js";
import { nextVersionNumber, recordVersion } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest } from "./fsstore.js";
import { highestVersionOnDisk } from "./workspace.js";
import { findFfmpeg, storyboard, RECORDINGS_DIR } from "./demo.js";
import { themed, resolveThemeTokens } from "./theme-source.js";

export const CUT_FILE = "demo-cut.json";
export class CutError extends Error {
  constructor(error, field, status = 400, extra = {}) {
    super(error);
    this.status = status;
    this.payload = { error, ...(field ? { field } : {}), ...extra };
  }
}
const bad = (field) => { throw new CutError("invalid_body", field); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function closed(value, keys, field) {
  if (!object(value)) bad(field);
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad(`${field}.${key}`);
}
function text(value, field) {
  if (typeof value !== "string" || value.length > 80 || /[\r\n]/.test(value)) bad(field);
}

export function defaultStyle(rawTitle = "Demo") {
  // The style's own text rule (≤ 80 chars, one line), so a GET's style always PUTs back.
  const title = String(rawTitle ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 80) || "Demo";
  return {
    theme: {
      titleCard: { on: true, title, subtitle: "", seconds: 2.5 },
      endCard: { on: true, title: "Thanks for watching", subtitle: "", seconds: 2.5 },
      background: "#0b1020", foreground: "#ffffff", accent: "#0891b2", font: "Inter",
    },
    captions: { on: true, burnIn: true, position: "bottom", size: 36, maxLines: 2, wrapChars: 42, style: "bar" },
  };
}

/** Optional fields merge into the existing style; unknown keys fail at every depth. */
export function validateStyle(value, title = "Demo", base = defaultStyle(title)) {
  closed(value, ["theme", "captions"], "style");
  const result = structuredClone(base);
  if (value.theme !== undefined) {
    closed(value.theme, Object.keys(result.theme), "style.theme");
    for (const [key, v] of Object.entries(value.theme)) {
      const field = `style.theme.${key}`;
      if (key === "titleCard" || key === "endCard") {
        closed(v, ["on", "title", "subtitle", "seconds"], field);
        for (const [k, x] of Object.entries(v)) {
          if (k === "on" && typeof x !== "boolean") bad(`${field}.${k}`);
          if ((k === "title" || k === "subtitle")) text(x, `${field}.${k}`);
          // A card is a title beat, 0.5 to 10 s: an unbounded one would encode an arbitrarily long video.
          if (k === "seconds" && (!Number.isFinite(x) || x < 0.5 || x > 10)) bad(`${field}.${k}`);
        }
        Object.assign(result.theme[key], v);
      } else {
        if (key === "font") {
          if (!["Inter", "Roboto", "Source Sans 3", "IBM Plex Sans", "system-ui"].includes(v)) bad(field);
        } else { text(v, field); if (!isColor(v)) bad(field); }
        result.theme[key] = v;
      }
    }
  }
  if (value.captions !== undefined) {
    closed(value.captions, Object.keys(result.captions), "style.captions");
    for (const [key, v] of Object.entries(value.captions)) {
      const field = `style.captions.${key}`;
      if (["on", "burnIn"].includes(key) && typeof v !== "boolean") bad(field);
      if (key === "position" && !["bottom", "top"].includes(v)) bad(field);
      if (key === "style" && !["bar", "outline", "plain"].includes(v)) bad(field);
      const bounds = { size: [18, 72], maxLines: [1, 3], wrapChars: [20, 80] }[key];
      if (bounds && (!Number.isFinite(v) || v < bounds[0] || v > bounds[1]
        || (key !== "size" && !Number.isInteger(v)))) bad(field);
      result.captions[key] = v;
    }
  }
  return result;
}

export function chapterIds(labels) {
  const used = new Set();
  return labels.map((label) => {
    const slug = String(label).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "chapter";
    let id = slug, n = 2;
    while (used.has(id)) id = `${slug}-${n++}`;
    used.add(id);
    return id;
  });
}

export function loadCut(dir) {
  const path = join(dir, CUT_FILE);
  if (!existsSync(path)) throw new CutError("no_cut", null, 404);
  return JSON.parse(readFileSync(path, "utf8"));
}
export function checkRev(cut, rev) {
  if (rev !== cut.rev) throw new CutError("rev_moved", null, 409, { rev: cut.rev });
}

export function validateRecut(cut, body) {
  closed(body, ["rev", "chapters", "style"], "body");
  checkRev(cut, body.rev);
  if (!Array.isArray(body.chapters) || body.chapters.length !== cut.chapters.length) bad("chapters");
  const seen = new Set();
  const chapters = body.chapters.map((entry, index) => {
    const field = `chapters.${index}`;
    closed(entry, ["id", "title", "take", "inSec", "outSec"], field);
    const current = cut.chapters.find((c) => c.id === entry.id);
    if (!current || seen.has(entry.id)) bad(`${field}.id`);
    seen.add(entry.id);
    if (entry.title !== undefined) text(entry.title, `${field}.title`);
    const chapter = { ...current, ...entry };
    const take = Object.hasOwn(cut.takes, chapter.id) ? cut.takes[chapter.id].find((t) => t.file === chapter.take) : undefined;
    if (!take) bad(`${field}.take`);
    if (!Number.isFinite(chapter.inSec) || chapter.inSec < 0) bad(`${field}.inSec`);
    if (!Number.isFinite(chapter.outSec) || chapter.outSec > take.durationSec
      || chapter.outSec - chapter.inSec < 0.5 - Number.EPSILON * 8) bad(`${field}.outSec`);
    return chapter;
  });
  return { ...cut, chapters, style: body.style === undefined ? cut.style : validateStyle(body.style, "Demo", cut.style) };
}

// One runner per binary in production; one probe per runner, including injected fakes.
const binaryRunners = new Map();
const runnerFilters = new WeakMap();
/** One ffmpeg call: asynchronous (an encode never blocks the service), killed after `timeoutMs`. */
export function ffmpegRunner(ffmpegPath) {
  if (binaryRunners.has(ffmpegPath)) return binaryRunners.get(ffmpegPath);
  const runner = (args, { cwd, timeoutMs = 180_000 } = {}) => new Promise((resolve) => {
    let out = "", error = null;
    const child = spawn(ffmpegPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk) => { out = (out + chunk).slice(-64 * 1024); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { error = new Error(`ffmpeg timed out after ${timeoutMs} ms`); child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { error = e; });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status: error ? null : status, stderr: out, error }); });
  });
  binaryRunners.set(ffmpegPath, runner);
  return runner;
}
export function ffmpegContext(opts = {}) {
  const path = opts.ffmpegPath !== undefined ? opts.ffmpegPath : opts.runner ? "injected" : findFfmpeg();
  if (!path) throw new CutError("ffmpeg_missing", null, 400, { hint: "Install ffmpeg (brew install ffmpeg / apt install ffmpeg), or set WI_FFMPEG." });
  return { path, runner: opts.runner ?? ffmpegRunner(path) };
}
export async function ffmpegCapabilities(opts = {}) {
  let ctx;
  try { ctx = ffmpegContext(opts); }
  catch (e) { if (e.payload?.error === "ffmpeg_missing") return { ok: false, burnIn: false }; throw e; }
  const cache = runnerFilters;
  const key = ctx.runner;
  if (!cache.has(key)) {
    const r = await ctx.runner(["-hide_banner", "-filters"]);
    if (r.status !== 0) throw new CutError("ffmpeg_failed", null, 400, { detail: String(r.stderr).slice(-1000) });
    cache.set(key, /^\s*[TSC.]+\s+ass\s/m.test(String(r.stderr)));
  }
  return { ok: true, burnIn: cache.get(key) };
}
export async function runFfmpeg(runner, args, opts) {
  const r = await runner(args, opts);
  if (r.status !== 0) throw new CutError("ffmpeg_failed", null, 400, { detail: String(r.stderr || r.error || "encoder failed").slice(-1000) });
  return r;
}

export function timeline(cut) {
  let at = cut.style.theme.titleCard.on ? cut.style.theme.titleCard.seconds : 0;
  return cut.chapters.map((chapter) => {
    const start = at;
    at += chapter.outSec - chapter.inSec;
    return { ...chapter, at: start, end: at };
  });
}
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of String(text).trim().split(/\s+/).filter(Boolean)) {
    let rest = word;
    if (line && line.length + 1 + rest.length > width) { lines.push(line); line = ""; }
    while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width); }
    line = line ? `${line} ${rest}` : rest;
  }
  if (line) lines.push(line);
  return lines;
}
export function captionEvents(cut, { captions: withCaptions = true } = {}) {
  const events = [], { theme, captions } = cut.style;
  const card = (c, start) => {
    if (c.on && (c.title || c.subtitle)) events.push({ start, end: start + c.seconds, style: "Card", lines: [c.title, c.subtitle].filter(Boolean) });
  };
  card(theme.titleCard, 0);
  const chapters = timeline(cut);
  if (captions.on && withCaptions) for (const c of chapters) {
    const lines = wrap(c.say || "", captions.wrapChars);
    const count = Math.ceil(lines.length / captions.maxLines);
    for (let i = 0; i < count; i++) events.push({
      start: c.at + (c.end - c.at) * i / count,
      end: c.at + (c.end - c.at) * (i + 1) / count,
      style: "Caption", lines: lines.slice(i * captions.maxLines, (i + 1) * captions.maxLines),
    });
  }
  card(theme.endCard, chapters.at(-1)?.end ?? (theme.titleCard.on ? theme.titleCard.seconds : 0));
  return events;
}
function timestamp(seconds, ass = false) {
  const units = ass ? 100 : 1000;
  const t = Math.round(seconds * units);
  return `${ass ? Math.floor(t / units / 3600) : String(Math.floor(t / units / 3600)).padStart(2, "0")}:${String(Math.floor(t / units / 60) % 60).padStart(2, "0")}:${String(Math.floor(t / units) % 60).padStart(2, "0")}.${String(t % units).padStart(ass ? 2 : 3, "0")}`;
}

/** Resolve the CSS colour grammar to numeric RGBA (ffmpeg/ASS do not parse CSS). */
function rgba(color, vars = {}, seen = []) {
  if (color.startsWith("var(")) {
    const key = color.slice(4, -1);
    const resolved = vars[key]?.trim();
    // An alias chain (var → var → colour) resolves, bounded and cycle-free; a missing variable, a cycle, or a
    // variable that holds a font, a size or a shadow is refused.
    if (!resolved || seen.includes(key) || seen.length >= 8 || !isColor(resolved)) throw new CutError("unresolved_color", key);
    return rgba(resolved, vars, [...seen, key]);
  }
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    if (hex.length === 6) hex += "ff";
    return hex.match(/../g).map((n) => parseInt(n, 16));
  }
  const parts = color.slice(color.indexOf("(") + 1, -1).split(",").map((v) => v.trim());
  const alpha = parts[3] === undefined ? 255 : Math.round(Math.min(1, parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1)) * 255);
  if (/^rgb/i.test(color)) return [...parts.slice(0, 3).map((v) => Math.round(Math.min(255, parseFloat(v) * (v.endsWith("%") ? 2.55 : 1)))), alpha];
  const h = parseFloat(parts[0]) % 360 / 60, s = Math.min(1, parseFloat(parts[1]) / 100), l = Math.min(1, parseFloat(parts[2]) / 100);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [...rgb.map((v) => Math.round((v + m) * 255)), alpha];
}
const hexByte = (n) => n.toString(16).padStart(2, "0").toUpperCase();
function assColor(color, vars) {
  const [r, g, b, a] = rgba(color, vars);
  return `&H${[255 - a, b, g, r].map(hexByte).join("")}`;
}
// Author text is literal: a word joiner after each backslash means libass reads no escape (`\N`, `\n`, `\h`), and
// braces are escaped so no override block opens. Only writeAss's own `\N` joins lines.
const assText = (s) => s.replace(/\\/g, "\\\u2060").replace(/{/g, "\\{").replace(/}/g, "\\}");
/** The burned-in overlay: card text always, chapter captions only when `captions` (the style's burnIn). */
export function writeAss(cut, vars = {}, { captions = true } = {}) {
  const { theme: t, captions: c } = cut.style;
  const fg = assColor(t.foreground, vars), bg = assColor(t.background, vars), accent = assColor(t.accent, vars);
  const border = c.style === "bar" ? 3 : 1, outline = c.style === "plain" ? 0 : c.style === "bar" ? 12 : 2;
  const format = "Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
  const style = (name, size, alignment, bs, ol) => `Style: ${name},${t.font},${size},${fg},${accent},${bg},${bg},0,0,0,0,100,100,0,0,${bs},${ol},0,${alignment},64,64,48,1`;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: ${format}\n${style("Caption", c.size, c.position === "top" ? 8 : 2, border, outline)}\n${style("Card", 64, 5, 1, 0)}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    captionEvents(cut, { captions }).map((e) => `Dialogue: 0,${timestamp(e.start, true)},${timestamp(e.end, true)},${e.style},,0,0,0,,${e.lines.map(assText).join("\\N")}`).join("\n") + "\n";
}
export function writeVtt(cut) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "WEBVTT\n\n" + captionEvents(cut).map((e, i) => `${i + 1}\n${timestamp(e.start)} --> ${timestamp(e.end)}\n${e.lines.map(esc).join("\n")}\n`).join("\n");
}

export function renderArgs(dir, cut, version, burnIn, vars = {}) {
  const inputs = [], args = ["-y", "-hide_banner", "-filter_complex_threads", "1"];
  const addCard = (card) => {
    if (!card.on) return;
    const color = rgba(cut.style.theme.background, vars);
    args.push("-f", "lavfi", "-i", `color=c=0x${color.slice(0, 3).map(hexByte).join("")}:s=1920x1080:d=${card.seconds}:r=30`);
    inputs.push(card.seconds);
  };
  addCard(cut.style.theme.titleCard);
  for (const c of cut.chapters) {
    args.push("-ss", String(c.inSec), "-to", String(c.outSec), "-i", join(dir, RECORDINGS_DIR, c.take));
    inputs.push(c.outSec - c.inSec);
  }
  addCard(cut.style.theme.endCard);
  if (!inputs.length) bad("chapters");
  const filters = inputs.map((_, i) => `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
  filters.push(inputs.map((_, i) => `[v${i}]`).join("") + `concat=n=${inputs.length}:v=1:a=0[stitched]`);
  // ffmpeg runs in the recordings directory, so the ASS file is a plain basename (no path quoting layers).
  filters.push(`[stitched]${burnIn ? `ass=_v${version}.ass` : "null"}[out]`);
  return [...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, RECORDINGS_DIR, `_v${version}.mp4`)];
}

export async function renderCut(dir, cut, opts = {}) {
  const ctx = ffmpegContext(opts);
  const capabilities = await ffmpegCapabilities({ ...opts, ffmpegPath: ctx.path, runner: ctx.runner });
  // Above the manifest AND any number a pending feedback file reserved on disk (as writeFeedback/forkVersion do).
  const manifest = loadManifest(dir), parent = manifest.head;
  const version = Math.max(nextVersionNumber(manifest), highestVersionOnDisk(dir) + 1);
  const rec = join(dir, RECORDINGS_DIR);
  mkdirSync(rec, { recursive: true });
  const tokens = opts.tokens ?? resolveThemeTokens(opts.theme);
  const vars = { ...Object.fromEntries([...themeCss(tokens).matchAll(/(--wi-[a-z-]+):([^;{}]+);/g)].map((m) => [m[1], m[2]])), ...opts.colorVars };
  const { titleCard, endCard } = cut.style.theme;
  const cardText = [titleCard, endCard].some((c) => c.on && (c.title || c.subtitle));
  atomicWrite(join(rec, `_v${version}.ass`), writeAss(cut, vars, { captions: cut.style.captions.burnIn }));
  atomicWrite(join(rec, `_v${version}.vtt`), writeVtt(cut));
  const burnIn = cut.style.captions.burnIn && capabilities.burnIn;
  // The overlay carries the cards' text even with caption burn-in off; it needs libass either way.
  const overlay = capabilities.burnIn && (cut.style.captions.burnIn || cardText);
  await runFfmpeg(ctx.runner, renderArgs(dir, cut, version, overlay, vars), { cwd: rec });
  await runFfmpeg(ctx.runner, ["-y", "-i", join(rec, `_v${version}.mp4`), "-frames:v", "1", "-q:v", "2", join(rec, `_v${version}-poster.jpg`)], { cwd: rec });
  const html = storyboard({ documentId: opts.documentId ?? "doc", title: cut.style.theme.titleCard.title,
    url: opts.url ?? cut.url ?? "", videoFile: null, mp4File: `_v${version}.mp4`, posterFile: `_v${version}-poster.jpg`,
    steps: timeline(cut).map((c) => ({ label: c.title, at: c.at })) });
  atomicWrite(join(dir, `_v${version}.html`), themed(instrument(html).html, opts));
  const landed = recordVersion(manifest, { version, parent }).manifest;
  landed.versions.at(-1).render = { mp4: `_v${version}.mp4`, vtt: `_v${version}.vtt`, ass: `_v${version}.ass`,
    burnIn: cut.style.captions.burnIn && !capabilities.burnIn ? "unavailable" : burnIn,
    cardText: cardText && !capabilities.burnIn ? "unavailable" : cardText };
  saveManifest(dir, landed);
  const saved = { ...cut, rev: cut.rev + 1, version };
  atomicWrite(join(dir, CUT_FILE), JSON.stringify(saved, null, 2));
  // The bus's own vocabulary (the fork and theme routes announce a version the same way).
  opts.emit?.("wicked.interactive.version.created", { version, parent, kind: "demo", html_file: `_v${version}.html` });
  return { rev: saved.rev, version, parent };
}

/** Extract frame-accurate chapter takes from the SAME caption-free browser run. */
export async function extractTakes(dir, recording, steps, duration, meta, opts = {}) {
  const ctx = ffmpegContext(opts), rec = join(dir, RECORDINGS_DIR);
  const existing = existsSync(join(dir, CUT_FILE)) ? loadCut(dir) : null;
  if (opts.chapter !== undefined && !existing?.chapters.some((c) => c.id === opts.chapter)) bad("chapter");
  const ids = chapterIds(steps.map((s) => s.label));
  const changed = existing !== null && (ids.length !== existing.chapters.length || ids.some((id) => !existing.chapters.some((c) => c.id === id)));
  // One chapter re-taken needs the same chapters; a full take of a re-authored spec starts a new cut (its
  // chapters and takes), keeping the style and the rev sequence.
  if (changed && opts.chapter !== undefined) bad("chapters");
  const fresh = existing && !changed ? structuredClone(existing)
    : { rev: existing?.rev ?? 0, version: existing?.version ?? null, chapters: [], takes: {},
        style: existing?.style ?? defaultStyle(meta.title || opts.documentId || "Demo") };
  // The recorded app's address, kept for every later re-cut's storyboard link.
  const cut = { ...fresh, url: String(meta.url ?? fresh.url ?? "") };
  // Every take is checked before the first encode, so a bad step leaves no files behind.
  if (!steps.length) bad("chapters");
  steps.forEach((s, index) => {
    if (opts.chapter !== undefined && opts.chapter !== ids[index]) return;
    if ((steps[index + 1]?.at ?? duration) - s.at < 0.5) bad(`chapters.${index}.durationSec`);
  });
  const added = [];
  for (const [index, s] of steps.entries()) {
    const id = ids[index];
    if (opts.chapter !== undefined && opts.chapter !== id) continue;
    const seconds = (steps[index + 1]?.at ?? duration) - s.at;
    let n = 1;
    while (readdirSync(rec).some((f) => f === `_take-${id}-${n}.webm` || f === `_take-${id}-${n}.mp4`)) n++;
    const file = `_take-${id}-${n}.webm`;
    const trim = ["-y", "-ss", String(s.at), "-to", String(s.at + seconds), "-i", join(rec, recording), "-an", "-threads", "2"];
    await runFfmpeg(ctx.runner, [...trim, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", join(rec, file)], { cwd: rec });
    await runFfmpeg(ctx.runner, [...trim, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(rec, file.replace(/webm$/, "mp4"))], { cwd: rec });
    const take = { file, durationSec: seconds, at: new Date().toISOString() };
    if (!Object.hasOwn(cut.takes, id)) cut.takes[id] = [];
    cut.takes[id].push(take);
    const chapter = cut.chapters.find((c) => c.id === id);
    const fields = { take: file, inSec: 0, outSec: seconds, say: s.say || "" };
    if (chapter) Object.assign(chapter, fields);
    else cut.chapters.push({ id, title: s.label, ...fields });
    added.push({ chapter: id, file, durationSec: seconds });
  }
  const result = await renderCut(dir, cut, opts);
  return { ...result, takes: added };
}
