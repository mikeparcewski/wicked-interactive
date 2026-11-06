// pptx.js — export a version to a native, editable PowerPoint (ADR-0020, interactive#322).
//
// Built in Node with pptxgenjs: a normal dependency that installs with the bridge, so the export
// works on a stock install (the vendored python-pptx builder it replaces needed a Python env that
// nothing installed). Structure-based, not pixel-based, exactly as before:
//   - the deck's slides are its TOP-LEVEL slide containers (core/deck.js `topSlides`, the same
//     slides the editor, the deck ops and the PDF export count);
//   - a slide's first heading is its title; headings, paragraphs and list items are its body, in
//     reading order (a block nested in a block flows into the outer one);
//   - `aside[data-notes-for]` is the speaker notes, never slide text (I-D1);
//   - content before the first slide joins it; content between slides joins the slide before it.
// Colours and fonts come from the exported version's OWN theme block (`style[data-wi-theme]`), so
// a restyled version exports in its theme; a version without one gets the default theme.

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { createRequire } from "node:module";
import { topSlides } from "../core/deck.js";
import { DEFAULT_THEME } from "../core/theme.js";
import { downloadBase } from "./export.js";

// pptxgenjs's ESM build is a .js file in a package without "type":"module", which a Node before 20.19 loads as
// CommonJS and fails on; its CommonJS build loads everywhere the engines range allows.
const PptxGenJS = createRequire(import.meta.url)("pptxgenjs");

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCKS = new Set([...HEADINGS, "p", "li", "dt", "dd", "figcaption", "caption"]);
// Phrasing elements: their text flows into the run around them, as a browser lays them out.
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "button", "cite", "code", "data", "dfn", "em", "i", "input", "kbd",
  "label", "mark", "q", "s", "samp", "select", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
// Never slide text: code, styling, metadata, fallbacks a browser doesn't draw (canvas, iframe, object, media),
// option lists (a select shows only its choice), SVG's accessible title/description and unpainted definitions.
const NEVER = new Set(["script", "style", "template", "noscript", "head", "title", "meta", "link", "base", "canvas", "iframe",
  "object", "embed", "video", "audio", "option", "datalist", "desc", "defs", "symbol", "clippath", "mask", "pattern", "marker"]);
const NOTES = "aside[data-notes-for]";
// An inline `display:none` hides a whole subtree. (An inline `visibility:hidden` is treated the same: a descendant
// that sets itself visible again is not looked for; the export is structural, not a render.)
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i;
// XML 1.0 can't carry these (C0 controls but tab/LF/CR, U+FFFE/FFFF, unpaired surrogates): a .pptx holding one is invalid.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Structure markers while text is normalized: a line break (`<br>`, a block boundary) and the bounds of
// preformatted text. U+0000 can't come from parsed HTML text (the parser drops or replaces it), so no
// authored character is mistaken for one.
const BREAK = "\u0000|", PRE_OPEN = "\u0000[", PRE_CLOSE = "\u0000]";

const tagOf = (el) => String(el.tagName || el.name || "").toLowerCase();

/** Text as PowerPoint can hold it. */
export const xmlSafe = (s) => String(s ?? "").replace(NOT_XML, "");

/**
 * Lines of text, as a reader sees them: outside preformatted text every run of whitespace (source newlines
 * included) is one space and only explicit breaks start a line, blank lines dropped; preformatted text keeps
 * its whitespace and line breaks exactly.
 */
function normalize(raw) {
  const lines = [];
  let cur = { text: "", pre: false };
  const next = (pre) => { lines.push(cur); cur = { text: "", pre }; };
  for (const [i, part] of String(raw).split(/\u0000[[\]]/).entries()) {
    const pre = i % 2 === 1;
    const pieces = pre ? part.split(BREAK).join("\n").split("\n") : part.replace(/[ \t\n\r\f\v\u00a0]+/g, " ").split(BREAK);
    pieces.forEach((piece, j) => { if (j > 0) next(pre); cur.text += piece; if (pre) cur.pre = true; });
  }
  lines.push(cur);
  // Blank lines between blocks go; blank lines inside preformatted text are the author's and stay.
  return xmlSafe(lines.filter((l) => l.pre || l.text.trim() !== "").map((l) => (l.pre ? l.text : l.text.trim())).join("\n"));
}

/**
 * The deck as slides: `[{ title, blocks: [[kind, text]], notes }]`, kind "head" | "para" | "bullet".
 * Pure (HTML in, data out) so the parser is testable without writing a file. The slides are core/deck.js's
 * `topSlides` (found before anything is skipped, so a hidden wrapper never drops one). Every piece of visible
 * text lands somewhere: headings, paragraphs and list items as themselves, a table row as one line of its cells,
 * and loose text (a `<div><b>1.</b><span>Page</span></div>` card) as a paragraph. A `<br>` is a line break,
 * `<pre>` keeps its lines. Hidden content (`hidden`, an inline `display:none`/`visibility:hidden`) is not slide
 * text; speaker notes (`aside[data-notes-for]`) are the slide's notes, never its text.
 */
export function extractSlides(html) {
  const $ = cheerio.load(String(html ?? ""));
  const tops = new Set(topSlides($));
  // Every ancestor of a slide: never flattened into one block, so each slide inside it is reached.
  const holdsTop = new Set();
  for (const el of tops) for (let p = el.parent; p; p = p.parent) holdsTop.add(p);
  const isNotes = (el) => tagOf(el) === "aside" && el.attribs?.["data-notes-for"] !== undefined;
  const inputText = (el) => {
    const type = String(el.attribs?.type ?? "text").toLowerCase();
    if (["hidden", "checkbox", "radio", "file", "image", "range", "color"].includes(type)) return "";
    const v = el.attribs?.value ?? "";
    return type === "password" ? "\u2022".repeat(v.length) : v;
  };
  const visible = (el) => el.attribs?.hidden === undefined && !HIDDEN_STYLE.test(el.attribs?.style ?? "");
  const shown = (el) => !NEVER.has(tagOf(el)) && visible(el);
  const isInline = (el) => INLINE.has(tagOf(el))
    && !$(el).find("*").toArray().some((d) => !INLINE.has(tagOf(d)) && tagOf(d) !== "option" && shown(d));

  // A select shows its chosen option (the first, when none is chosen); its list isn't on the slide.
  const selectText = (el) => {
    const opts = $(el).find("option").toArray();
    const chosen = opts.find((o) => o.attribs?.selected !== undefined) ?? opts[0];
    return chosen ? $(chosen).text() : "";
  };
  /** A run of nodes as raw text: authored adjacency kept (`1<span>0</span>` is "10"), breaks marked, nothing invented. */
  const serialize = (nodes) => {
    let out = "", inCells = false;
    for (const n of nodes) {
      if (n.type === "text") { out += n.data ?? ""; continue; }
      if (n.type !== "tag" || isNotes(n)) continue;
      const tag = tagOf(n);
      if (tag === "select") { if (visible(n)) out += selectText(n); continue; }
      if (!shown(n)) continue;
      if (tag === "br") { out += BREAK; continue; }
      if (tag === "textarea") { out += `${BREAK}${PRE_OPEN}${$(n).text()}${PRE_CLOSE}${BREAK}`; continue; }
      if (tag === "pre") { out += `${BREAK}${PRE_OPEN}${serialize($(n).contents().toArray())}${PRE_CLOSE}${BREAK}`; continue; }
      if (tag === "input") { out += inputText(n); continue; }
      if (tag === "td" || tag === "th") { out += (inCells ? " | " : "") + serialize($(n).contents().toArray()); inCells = true; continue; }
      if (!isInline(n)) { out += `${BREAK}${serialize($(n).contents().toArray())}${BREAK}`; continue; }
      out += serialize($(n).contents().toArray());
    }
    return out;
  };
  const textOf = (el) => normalize(serialize($(el).contents().toArray()));

  const slides = [];
  let cur = null;
  const open = (explicit) => { cur = { title: null, titleAt: 0, blocks: [], notes: "", explicit }; slides.push(cur); };
  const add = (kind, text) => {
    if (!text) return;
    if (cur === null) open(false);
    if (kind === "head" && cur.title === null) { cur.title = text; cur.titleAt = cur.blocks.length; }
    else cur.blocks.push([kind, text]);
  };
  // Outside every slide, notes belong to the slide being read; with none yet they are dropped.
  // Speaker notes are plain text (notes-set writes them so): their line breaks are kept, each line tidied.
  const notesText = (el) => {
    // Block boundaries are one break however many meet; the author's own blank lines stay.
    const lines = serialize($(el).contents().toArray()).replace(/(?:\u0000\|)+/g, BREAK).split(BREAK).join("\n").split("\n")
      .map((l) => l.replace(/[ \t\r\f\v\u00a0]+/g, " ").trim());
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines.at(-1) === "") lines.pop();
    return xmlSafe(lines.join("\n")); // a blank line between paragraphs stays
  };
  const note = (el) => {
    const t = notesText(el);
    if (t && cur !== null) cur.notes = cur.notes ? `${cur.notes}\n${t}` : t;
  };
  const notesIn = (el) => $(el).find(NOTES).each((_, n) => note(n));
  // `hidden`: inside a hidden element that holds slides, only the slides are kept (core counts them), and they are
  // kept blank: nothing a reader can't see becomes slide text. Their speaker notes are still their notes.
  const walk = (node, hidden = false) => {
    let run = [];
    const flush = () => { add("para", normalize(serialize(run))); run = []; };
    for (const child of $(node).contents().toArray()) {
      if (child.type === "text") { if (!hidden) run.push(child); continue; }
      if (child.type !== "tag") continue;
      if (isNotes(child)) { flush(); note(child); continue; }
      if (tops.has(child)) { flush(); open(true); walk(child, hidden || !shown(child)); continue; }
      if (holdsTop.has(child)) { flush(); walk(child, hidden || !shown(child)); continue; }
      if (hidden) { notesIn(child); continue; }
      if (!shown(child)) { notesIn(child); continue; }
      const tag = tagOf(child);
      if (tag === "br") { run.push(child); continue; }
      if (isInline(child)) { run.push(child); notesIn(child); continue; }
      flush();
      if (tag === "pre" || tag === "textarea") { add("para", normalize(serialize([child]))); notesIn(child); continue; }
      if (BLOCKS.has(tag)) {
        add(HEADINGS.has(tag) ? "head" : tag === "li" ? "bullet" : "para", textOf(child));
        notesIn(child); // a notes aside nested in a block is still that slide's notes
        continue;
      }
      if (tag === "tr") { add("para", normalize(serialize($(child).children("td, th").toArray()))); notesIn(child); continue; }
      walk(child);
    }
    flush();
  };
  // A hidden page (`<body hidden>`, `<html style="display:none">`) shows none of its slides' text either.
  const start = $("body").length ? $("body") : $.root();
  walk(start, $("body").length > 0 && [$("body")[0], $("html")[0]].some((el) => el && !shown(el)));
  // The deck's own slides are all kept (an inserted slide is blank until it is written); implicit
  // ones (content outside any slide) only when they hold something.
  let kept = slides.filter((s) => s.explicit || s.title || s.blocks.length || s.notes);
  // Once there are slide containers the slide count is theirs: content BEFORE the first one is
  // folded into it in reading order, never dropped (core/deck.js counts the same slides).
  const first = kept.findIndex((s) => s.explicit);
  if (first > 0) {
    const lead = kept.slice(0, first), target = kept[first];
    const reading = [];
    for (const s of [...lead, target]) {
      const b = [...s.blocks];
      if (s.title) b.splice(s.titleAt, 0, ["head", s.title]);
      reading.push(...b);
    }
    const at = reading.findIndex(([kind]) => kind === "head");
    target.title = at >= 0 ? reading.splice(at, 1)[0][1] : null;
    target.blocks = reading;
    target.notes = [...lead.map((s) => s.notes), target.notes].filter(Boolean).join("\n");
    kept = kept.slice(first);
  }
  if (kept.length === 0) kept = [{ title: "Untitled", blocks: [], notes: "" }];
  return kept.map(({ title, blocks, notes }) => ({ title, blocks, notes }));
}

// ── Theme: read back from the version's own theme block ─────────────────────────────────────────

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = String.raw`([\d.]+%?)`;
const RGB = new RegExp(String.raw`^rgba?\(\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*(?:,\s*${NUM}\s*)?\)$`, "i");
const HSL = new RegExp(String.raw`^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*${NUM}\s*)?\)$`, "i");
const clamp = (n, hi) => Math.max(0, Math.min(hi, n));
const channel = (c) => clamp(c.endsWith("%") ? Math.round((parseFloat(c) * 255) / 100) : Math.round(parseFloat(c)), 255);
const alphaOf = (a) => (a === undefined ? 1 : clamp(a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a), 1));

/** A theme colour as `[r, g, b, alpha]`, or null when it isn't one the grammar writes. */
export function parseColor(value) {
  const v = String(value ?? "").trim();
  let m = HEX.exec(v);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return [...n, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = RGB.exec(v);
  if (m) return [channel(m[1]), channel(m[2]), channel(m[3]), alphaOf(m[4])];
  m = HSL.exec(v);
  if (m) {
    const h = (((parseFloat(m[1]) % 360) + 360) % 360) / 360, s = clamp(parseFloat(m[2]) / 100, 1), l = clamp(parseFloat(m[3]) / 100, 1);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const ch = (t) => {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((x) => Math.round(x * 255)).concat(alphaOf(m[4]));
  }
  return null;
}

/**
 * A theme colour as the opaque 6-digit hex PowerPoint takes, or null (an unreadable value falls back). A
 * translucent colour is composited over `under` (an opaque `[r, g, b]`, white by default), as it would show.
 */
export function toPptxColor(value, under = [255, 255, 255]) {
  const c = parseColor(value);
  if (!c) return null;
  const [r, g, b, a] = c;
  return [r, g, b].map((x, i) => Math.round(x * a + under[i] * (1 - a)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** The first family of a font list, unquoted (PowerPoint takes one face); null unless it is a plain family name,
 *  the theme grammar's (the builder writes it into an XML attribute unescaped). */
function firstFamily(value) {
  const f = String(value ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return /^[A-Za-z0-9 _-]{1,64}$/.test(f) ? f : null;
}

/** The `--wi-*` values of the version's theme block (`style[data-wi-theme]`), `var()` references resolved. */
export function versionThemeVars(html) {
  const $ = cheerio.load(String(html ?? ""));
  const css = $("style[data-wi-theme]").first().text();
  const vars = {};
  for (const m of css.matchAll(/(--wi-[a-z0-9-]+)\s*:\s*([^;}]*?)\s*(?:!important\s*)?(?=[;}])/gi)) {
    if (!(m[1] in vars)) vars[m[1]] = m[2];
  }
  // Follow `var(--wi-…)` references to a value; a cycle resolves to nothing (the default theme's colour is used).
  const resolve = (v, seen = new Set()) => {
    const r = /^var\(\s*(--wi-[a-z0-9-]+)\s*\)$/i.exec(String(v ?? "").trim());
    if (!r) return v;
    if (seen.has(r[1])) return undefined;
    seen.add(r[1]);
    return resolve(vars[r[1]], seen);
  };
  for (const k of Object.keys(vars)) vars[k] = resolve(vars[k]);
  return vars;
}

/** The colours and fonts the deck is drawn in: the version's theme, else the default theme. */
export function pptxTheme(html) {
  const v = versionThemeVars(html), c = DEFAULT_THEME.colors, f = DEFAULT_THEME.fonts;
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const bg = toPptxColor(v["--wi-bg"]) ?? toPptxColor(c.background);
  const on = (name, fallback) => toPptxColor(v[name], rgb(bg)) ?? toPptxColor(fallback, rgb(bg));
  return {
    bg,
    primary: on("--wi-primary", c.primary),
    accent: on("--wi-accent", c.accent),
    text: on("--wi-text", c.text_primary),
    headingFont: firstFamily(v["--wi-font-heading"]) ?? f.heading,
    bodyFont: firstFamily(v["--wi-font-body"]) ?? f.body,
  };
}

// ── Build ────────────────────────────────────────────────────────────────────────────────────────

/** The .pptx bytes for one version's HTML, and its slide count. */
export async function buildPptx(html) {
  const slides = extractSlides(html);
  const theme = pptxTheme(html);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33" × 7.5", the deck's 16:9
  for (const slide of slides) {
    const s = pptx.addSlide();
    s.background = { color: theme.bg };
    s.addText(xmlSafe(slide.title ?? ""), {
      x: 0.6, y: 0.45, w: 12.13, h: 1.2, valign: "top", fit: "shrink",
      fontSize: 34, bold: true, color: theme.primary, fontFace: theme.headingFont,
    });
    if (slide.blocks.length > 0) {
      s.addText(slide.blocks.map(([kind, text]) => ({
        text,
        options: {
          breakLine: true, paraSpaceAfter: 8, fontFace: theme.bodyFont,
          ...(kind === "bullet" ? { bullet: { indent: 18 }, indentLevel: 1 } : {}),
          ...(kind === "head" ? { fontSize: 22, bold: true, color: theme.accent } : { fontSize: 18, color: theme.text }),
        },
      })), { x: 0.6, y: 1.85, w: 12.13, h: 5.2, valign: "top", fit: "shrink" });
    }
    if (slide.notes) s.addNotes(xmlSafe(slide.notes));
  }
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  return { bytes, slides: slides.length };
}

/**
 * Build `<doc>_v{version}.pptx` from the version's HTML.
 * @returns {Promise<{ path: string, bytes: number, slides: number }>}
 */
export async function exportPptx(dir, version) {
  const htmlPath = join(dir, `_v${version}.html`);
  if (!existsSync(htmlPath)) throw new Error(`version ${version} not found`);
  const { bytes, slides } = await buildPptx(readFileSync(htmlPath, "utf-8"));
  const exportsDir = join(dir, "exports");
  mkdirSync(exportsDir, { recursive: true });
  const outPath = join(exportsDir, `${downloadBase(dir, version)}.pptx`);
  writeFileSync(outPath, bytes);
  return { path: outPath, bytes: statSync(outPath).size, slides };
}
