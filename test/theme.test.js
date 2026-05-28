import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { themeCss, themeStyleBlock, applyTheme, DEFAULT_THEME } from "../src/core/theme.js";
import { collectWids } from "../src/core/instrument.js";
import { resolveThemeTokens, themed } from "../src/service/theme-source.js";

test("themeCss emits :root custom properties and gentle base rules from tokens", () => {
  const css = themeCss(DEFAULT_THEME);
  assert.match(css, /:root\{/);
  assert.match(css, /--wi-primary:#1E3A5F;/);
  assert.match(css, /--wi-font-body:Calibri;/);
  assert.match(css, /body\{font-family:var\(--wi-font-body\)/);
  assert.match(css, /\[data-card\]\{background:var\(--wi-card-bg\)/);
});

test("themeCss skips tokens that are undefined (no 'undefined' leaks into CSS)", () => {
  const css = themeCss({ name: "sparse", colors: { primary: "#000" } });
  assert.ok(!css.includes("undefined"), "no undefined token should reach the CSS");
  assert.match(css, /--wi-primary:#000;/);
});

test("themeStyleBlock wraps CSS in a marked <style data-wi-theme>", () => {
  const block = themeStyleBlock(DEFAULT_THEME);
  assert.match(block, /^<style data-wi-theme="corporate-light">/);
  assert.match(block, /<\/style>$/);
});

test("applyTheme injects a theme block (fragment with no head → prepended to root)", () => {
  const out = applyTheme("<h1>Hi</h1><p>x</p>");
  assert.match(out, /<style data-wi-theme=/);
  // Block comes first, before the content.
  assert.ok(out.indexOf("data-wi-theme") < out.indexOf("<h1"), "theme block must precede content");
});

test("applyTheme is idempotent — running twice yields exactly one theme block", () => {
  const once = applyTheme("<h1>Hi</h1>");
  const twice = applyTheme(once);
  const count = (twice.match(/data-wi-theme=/g) || []).length;
  assert.equal(count, 1, "re-applying must replace, not stack");
});

test("applyTheme preserves every data-wid anchor (INV-1/INV-2 safe)", () => {
  const html = `<section data-wid="section-0"><h1 data-wid="slide-0-heading-1">T</h1></section>`;
  const before = collectWids(html);
  const after = collectWids(applyTheme(html));
  assert.deepEqual(after, before, "theming must not drop or add anchors");
});

test("applyTheme with theme:false is a no-op", () => {
  const html = "<h1>Hi</h1>";
  assert.equal(applyTheme(html, { theme: false }), html);
});

test("resolveThemeTokens reads a theme JSON from an explicit themesDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-themes-"));
  try {
    writeFileSync(join(dir, "midnight.json"), JSON.stringify({
      name: "midnight", colors: { primary: "#100020" }, fonts: { body: "Inter" },
    }));
    const tokens = resolveThemeTokens("midnight", { themesDir: dir });
    assert.equal(tokens.name, "midnight");
    assert.equal(tokens.colors.primary, "#100020");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveThemeTokens falls back to DEFAULT_THEME when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-themes-"));
  try {
    const tokens = resolveThemeTokens("does-not-exist", { themesDir: dir });
    assert.equal(tokens.name, DEFAULT_THEME.name);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("themed() resolves + applies in one step and honors theme:false", () => {
  const dir = mkdtempSync(join(tmpdir(), "wi-themes-"));
  try {
    writeFileSync(join(dir, "corporate-light.json"), JSON.stringify({
      name: "corporate-light", colors: { primary: "#abcdef" },
    }));
    const out = themed("<h1>Hi</h1>", { themesDir: dir });
    assert.match(out, /--wi-primary:#abcdef;/);
    assert.equal(themed("<h1>Hi</h1>", { theme: false }), "<h1>Hi</h1>");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
