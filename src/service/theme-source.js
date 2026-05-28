// theme-source.js — resolve theme tokens from the wicked-prezzie plugin cache (ADR-0016).
//
// wicked-prezzie is a required sibling plugin but is NOT importable as a library (it's a
// plugin/skill). We locate its `skills/theme/themes/<name>.json` under the same plugin search
// paths the preflight uses and read the tokens. On any miss we fall back to the bundled
// DEFAULT_THEME from core — resilience against prezzie's on-disk layout shifting, not
// plugin-optional behavior (the preflight still requires prezzie to be installed).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginSearchPaths } from "./preflight.js";
import { DEFAULT_THEME, applyTheme } from "../core/theme.js";

/** Locate prezzie's `skills/theme/themes` dir under any resolved plugin search path. */
export function prezzieThemesDir() {
  for (const base of pluginSearchPaths()) {
    const root = join(base, "wicked-prezzie");
    if (!existsSync(root)) continue;
    // Direct (test-fixture layout) then the nested pkg/version cache layout.
    const candidates = [join(root, "skills/theme/themes")];
    let pkgs = [];
    try { pkgs = readdirSync(root); } catch { pkgs = []; }
    for (const pkg of pkgs) {
      const pkgDir = join(root, pkg);
      candidates.push(join(pkgDir, "skills/theme/themes"));
      let vers = [];
      try { vers = readdirSync(pkgDir); } catch { vers = []; }
      for (const ver of vers) candidates.push(join(pkgDir, ver, "skills/theme/themes"));
    }
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Resolve a theme token object by name. Reads prezzie's JSON if present; falls back to the
 * bundled DEFAULT_THEME. Never throws — a missing/corrupt file degrades to the default so a
 * version is always produced.
 * @param {string} [name]
 * @param {object} [opts] { themesDir?: string } — themesDir overrides discovery (tests)
 */
export function resolveThemeTokens(name = "corporate-light", opts = {}) {
  const dir = opts.themesDir || prezzieThemesDir();
  if (dir) {
    const file = join(dir, `${name}.json`);
    try {
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
    } catch { /* fall through to default */ }
  }
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
