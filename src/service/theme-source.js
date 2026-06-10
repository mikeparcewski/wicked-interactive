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
 * Resolve the theme and apply it to an HTML string in one step — the seam used at every
 * version-creation point. `opts.theme === false` skips theming; a string picks the theme by
 * name; otherwise the default (`corporate-light`) is used.
 */
export function themed(html, opts = {}) {
  if (opts.theme === false) return html;
  const name = typeof opts.theme === "string" ? opts.theme : "corporate-light";
  const tokens = resolveThemeTokens(name, opts);
  return applyTheme(html, { tokens });
}
