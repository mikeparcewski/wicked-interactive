// theme.js — turn wicked-prezzie theme tokens into a per-version base <style> block
// (ADR-0011 theme step, ADR-0016 Slice C). PURE: no filesystem, no plugin discovery — token
// resolution from the prezzie plugin cache lives in service/theme-source.js. This keeps the
// core layer side-effect-free and unit-testable.
//
// The block uses element-level selectors so it is a genuine BASE layer: a document's own
// classed/inline styles win over it. It is injected FIRST (lowest precedence among equal
// specificity) and is idempotent — re-running replaces the previous block rather than
// stacking, so re-instrument after regenerate keeps a single, current theme block. It never
// touches data-wid anchors (INV-1/INV-2 safe — it only adds an anchor-free <style>).

import * as cheerio from "cheerio";

const THEME_MARKER = "data-wi-theme";

// Bundled fallback — a copy of prezzie's `corporate-light` tokens. Resilience against
// prezzie's on-disk layout changing, NOT plugin-optional behavior: the preflight still
// requires prezzie (ADR-0016). Guarantees the product themes consistently regardless.
export const DEFAULT_THEME = {
  name: "corporate-light",
  colors: {
    background: "#FFFFFF", surface: "#F8FAFC", primary: "#1E3A5F", secondary: "#2563EB",
    accent: "#0891B2", text_primary: "#1E293B", text_secondary: "#64748B", text_muted: "#94A3B8",
    border: "#E2E8F0", success: "#059669", warning: "#D97706", error: "#DC2626",
  },
  fonts: { heading: "Calibri", body: "Calibri", mono: "Consolas" },
  sizes: {
    title: "44px", subtitle: "26px", heading: "34px", subheading: "22px",
    body: "18px", caption: "13px", small: "11px",
  },
  spacing: { margin: "48px", gap_large: "32px", gap_medium: "24px", gap_small: "16px", gap_xs: "8px" },
  card: { background: "#FFFFFF", border_radius: "8px", padding: "24px", shadow: "0 1px 3px rgba(0,0,0,0.1)" },
};

/** Turn a theme token object into a base CSS string (custom properties + gentle base rules). */
export function themeCss(tokens = DEFAULT_THEME) {
  const c = tokens.colors || {}, f = tokens.fonts || {}, s = tokens.sizes || {}, card = tokens.card || {};
  const vars = [
    `--wi-bg:${c.background};`, `--wi-surface:${c.surface};`, `--wi-primary:${c.primary};`,
    `--wi-secondary:${c.secondary};`, `--wi-accent:${c.accent};`, `--wi-text:${c.text_primary};`,
    `--wi-text-secondary:${c.text_secondary};`, `--wi-muted:${c.text_muted};`, `--wi-border:${c.border};`,
    `--wi-font-heading:${f.heading};`, `--wi-font-body:${f.body};`, `--wi-font-mono:${f.mono};`,
    `--wi-size-title:${s.title};`, `--wi-size-heading:${s.heading};`, `--wi-size-body:${s.body};`,
    `--wi-card-bg:${card.background};`, `--wi-card-radius:${card.border_radius};`,
    `--wi-card-padding:${card.padding};`, `--wi-card-shadow:${card.shadow};`,
  ].filter((v) => !v.includes("undefined")).join("");
  return [
    `:root{${vars}}`,
    `body{font-family:var(--wi-font-body),system-ui,-apple-system,sans-serif;color:var(--wi-text);background:var(--wi-bg);}`,
    `h1,h2,h3,h4,h5,h6{font-family:var(--wi-font-heading),system-ui,sans-serif;color:var(--wi-primary);line-height:1.2;}`,
    `h1{font-size:var(--wi-size-title);}`,
    `h2{font-size:var(--wi-size-heading);}`,
    `a{color:var(--wi-secondary);}`,
    `[data-card]{background:var(--wi-card-bg);border:1px solid var(--wi-border);border-radius:var(--wi-card-radius);padding:var(--wi-card-padding);box-shadow:var(--wi-card-shadow);}`,
  ].join("\n");
}

/** The full `<style data-wi-theme="...">` block for a token object. */
export function themeStyleBlock(tokens = DEFAULT_THEME) {
  return `<style ${THEME_MARKER}="${tokens.name || "theme"}">\n${themeCss(tokens)}\n</style>`;
}

/**
 * Inject (or replace) the base theme block in an HTML fragment/document. Idempotent: any
 * existing `style[data-wi-theme]` is removed first. Injected FIRST so it's the base layer.
 * @param {string} html
 * @param {object} [opts] { tokens?: object, theme:false to skip injection }
 * @returns {string}
 */
export function applyTheme(html, opts = {}) {
  if (opts.theme === false) return html;
  const tokens = opts.tokens || DEFAULT_THEME;
  const $ = cheerio.load(html, null, false);
  $(`style[${THEME_MARKER}]`).remove();
  const block = themeStyleBlock(tokens);
  if ($("head").length) $("head").prepend(block);
  else $.root().prepend(block);
  return $.html();
}
