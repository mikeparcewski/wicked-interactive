// The video's default colours come from the operator's studio skin (operator, 2026-10-14: "the video color scheme
// should take the lead from the wicked skin by default"). crew resolves the skin (`studio.appearance`) into a
// palette at GET /api/v1/appearance/video-palette; this module reads it for a render, with a NEUTRAL fallback when
// no crew answers, and applies it to a cut's style unless the style chose custom colours.
import { isColor } from "../core/theme-grammar.js";
import { resolveCrewApi } from "./project.js";

/** Graphite and white: readable, and no brand colour of its own, for a render with no skin to follow. */
export const NEUTRAL_PALETTE = Object.freeze({
  canvas: "#16181d", surface: "#22252c", ink: "#f5f6f8", ink2: "#d4d7dd", muted: "#a2a7b1", line: "#33373f",
  accent: "#b8bec9", font: "system-ui", scheme: "dark",
});

const HEX = /^#[0-9a-f]{6}$/i;
const KEYS = ["canvas", "surface", "ink", "ink2", "muted", "line", "accent"];

/** A palette as crew sends it, checked: every colour `#rrggbb`, a short font name. Anything else is no palette. */
export function checkedPalette(raw) {
  if (raw === null || typeof raw !== "object") return null;
  if (!KEYS.every((k) => typeof raw[k] === "string" && HEX.test(raw[k]) && isColor(raw[k]))) return null;
  const font = typeof raw.font === "string" && /^[A-Za-z0-9 -]{1,40}$/.test(raw.font) ? raw.font : "system-ui";
  return { ...Object.fromEntries(KEYS.map((k) => [k, raw[k].toLowerCase()])), font, scheme: raw.scheme === "light" ? "light" : "dark" };
}

/**
 * The skin for one render: `{ palette, source, theme }`. `source` is "studio-skin" / "studio-default" (crew's) or
 * "fallback" (no crew configured, unreachable, slow or malformed: 1.5 s, never blocks a render).
 */
export async function fetchSkin({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const base = resolveCrewApi(env);
  if (!base || typeof fetchImpl !== "function") return { palette: NEUTRAL_PALETTE, source: "fallback", theme: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${base}/api/v1/appearance/video-palette`, { signal: ctl.signal });
    const body = r.ok ? await r.json() : null;
    const palette = checkedPalette(body?.palette);
    if (!palette) return { palette: NEUTRAL_PALETTE, source: "fallback", theme: null };
    return { palette, source: body.source === "studio-default" ? "studio-default" : "studio-skin", theme: typeof body.theme === "string" ? body.theme : null };
  } catch {
    return { palette: NEUTRAL_PALETTE, source: "fallback", theme: null };
  } finally {
    clearTimeout(timer);
  }
}

/** The colours a render uses: the skin's when the style follows it (`palette: "skin"`, the default), else the style's own. */
export function effectiveTheme(theme, skin) {
  if (theme.palette === "custom") return theme;
  const p = skin?.palette ?? NEUTRAL_PALETTE;
  return { ...theme, background: p.canvas, foreground: p.ink, accent: p.accent, font: p.font };
}
