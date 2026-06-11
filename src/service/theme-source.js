// theme-source.js — resolve theme tokens from the in-repo theme library (ADR-0020).
//
// The theme JSONs were absorbed from wicked-prezzie into src/themes/ when prezzie was merged,
// so resolution is now deterministic and dependency-free: read `src/themes/<name>.json`. On any
// miss we fall back to the bundled DEFAULT_THEME from core, so a version is always produced.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_THEME, applyTheme } from "../core/theme.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The shipped theme library: src/themes/ (sibling of src/service/). */
export function themesDir() {
  return join(HERE, "../themes");
}

/**
 * Resolve a theme token object by name. Reads the in-repo JSON if present; falls back to the
 * bundled DEFAULT_THEME. Never throws — a missing/corrupt file degrades to the default.
 * @param {string} [name]
 * @param {object} [opts] { themesDir?: string } — themesDir overrides the default location (tests)
 */
export function resolveThemeTokens(name = "corporate-light", opts = {}) {
  const dir = opts.themesDir || themesDir();
  const file = join(dir, `${name}.json`);
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch { /* fall through to default */ }
  return DEFAULT_THEME;
}

/**
 * A LEARNED theme (from "learn a theme from a URL") lives in the doc workspace at
 * `<docDir>/theme/learned.theme.json` — written by the agent after it reads the grabbed page's
 * design. When present it is applied at EVERY version-creation for that doc, so the learned brand
 * sticks without threading tokens through each event. Returns the token object, or null if absent
 * or unreadable (degrade to the named/default theme — never throw).
 */
export function resolveLearnedTheme(docDir) {
  try {
    const file = join(docDir, "theme", "learned.theme.json");
    if (existsSync(file)) {
      const tokens = JSON.parse(readFileSync(file, "utf-8"));
      if (tokens && typeof tokens === "object") return tokens;
    }
  } catch { /* degrade to the named/default theme */ }
  return null;
}

/**
 * Resolve the theme and apply it to an HTML string in one step — the seam used at every
 * version-creation point. `opts.theme === false` skips theming.
 *
 * Token resolution order (additive — default behavior unchanged):
 *  1. `opts.tokens` (an object) — a LEARNED theme: apply it verbatim, no name needed. This is the
 *     apply path for "learn a theme from a URL" — the agent synthesizes the token object and the
 *     version-creation seam re-themes with it directly (ADR-0020).
 *  2. `opts.theme` (a string) — pick the in-repo theme by name.
 *  3. otherwise the default (`corporate-light`).
 */
export function themed(html, opts = {}) {
  if (opts.theme === false) return html;
  if (opts.tokens && typeof opts.tokens === "object") return applyTheme(html, { tokens: opts.tokens });
  const name = typeof opts.theme === "string" ? opts.theme : "corporate-light";
  const tokens = resolveThemeTokens(name, opts);
  return applyTheme(html, { tokens });
}
