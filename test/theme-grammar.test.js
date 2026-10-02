// theme-grammar.test.js — the per-field token grammar a learned theme must fit (EP-I2).
//
// themeCss interpolates token values raw into CSS custom properties and the learned theme rides
// into every later version, so a value like `red;}body{background:url(https://x/?…)` must never
// reach it. The same check runs at the write route (PUT) and at the reader (resolveLearnedTheme).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThemeTokens } from "../src/core/theme-grammar.js";
import { DEFAULT_THEME } from "../src/core/theme.js";

const THEMES = join(dirname(fileURLToPath(import.meta.url)), "../src/themes");
const ok = (t) => assert.deepEqual(checkThemeTokens(t), { ok: true }, JSON.stringify(t));
const bad = (t, re) => {
  const r = checkThemeTokens(t);
  assert.equal(r.ok, false, `expected refusal: ${JSON.stringify(t)}`);
  if (re) assert.match(r.reason, re);
};

test("the bundled default and every shipped theme fit the grammar", () => {
  ok(DEFAULT_THEME);
  for (const f of readdirSync(THEMES).filter((n) => n.endsWith(".json"))) {
    ok(JSON.parse(readFileSync(join(THEMES, f), "utf-8")));
  }
});

test("a partial theme is fine; the shape is still checked", () => {
  ok({ name: "acme-learned", colors: { primary: "#8FB4FF" } });
  ok({ name: "x", spacing: {}, card: { shadow: "none" } });
  bad(null, /not-an-object/);
  bad([], /not-an-object/);
  bad("theme", /not-an-object/);
  bad({ colors: "red" }, /colors/);
  bad({ colors: { primary: 12 } }, /colors\.primary/);
  bad({ palette: { primary: "#fff" } }, /unknown-key:palette/);
  bad({ card: { border: "1px solid red" } }, /card\.border/);
});

test("colours: hex, numeric rgb/hsl, or a --wi- var; nothing else", () => {
  for (const c of ["#fff", "#FFFFFF", "#11223344", "rgb(0, 0, 0)", "rgba(0,0,0,0.5)", "hsl(210, 40%, 50%)", "hsla(210,40%,50%,.5)", "var(--wi-primary)"]) {
    ok({ colors: { primary: c } });
  }
  for (const c of ["red", "#ff", "#fffff", "rgb(calc(1),0,0)", "rgb(0,0,0);", "var(--x)", "url(https://x/)", "expression(alert(1))"]) {
    bad({ colors: { primary: c } }, /colors\.primary/);
  }
  bad({ card: { background: "red;}body{background:url(https://x/?a)" } }, /card\.background/);
});

test("fonts: a comma list of plain family names, quoted or not", () => {
  ok({ fonts: { heading: "Inter", body: "Inter, 'Helvetica Neue', sans-serif", mono: "\"JetBrains Mono\"" } });
  for (const f of ["Inter;}", "Inter, ", "'Inter", "Inter\nArial", "a".repeat(65), "Inter</style>"]) {
    bad({ fonts: { body: f } }, /fonts\.body/);
  }
});

test("lengths: 1-3 digits, up to 2 decimals, px|rem|em|pt", () => {
  for (const v of ["44px", "1.5rem", "0.75em", "12pt", "999px"]) ok({ sizes: { body: v }, spacing: { margin: v }, card: { padding: v, border_radius: v } });
  for (const v of ["44", "1000px", "1.555rem", "10%", "10vh", "-4px", "44px 2px"]) {
    bad({ sizes: { body: v } }, /sizes\.body/);
  }
  bad({ card: { padding: "24px;" } }, /card\.padding/);
});

test("card.shadow: none, or up to two `<len> <len> <len>? <colour>` shadows", () => {
  ok({ card: { shadow: "0 1px 3px rgba(0,0,0,0.1)" } });
  ok({ card: { shadow: "0 1px 3px rgba(0,0,0,0.1), 0 -2px #000" } });
  ok({ card: { shadow: "0 2px 6px rgba(0, 0, 0, 0.15)" } });
  bad({ card: { shadow: "0 1px #000, 0 2px #000, 0 3px #000" } }, /card\.shadow/);
  bad({ card: { shadow: "0 1px 3px url(x)" } }, /card\.shadow/);
  bad({ card: { shadow: "inset 0 1px #000" } }, /card\.shadow/);
});

test("name is an identifier (it lands in an HTML attribute); prose fields carry no markup or breakouts", () => {
  ok({ name: "stripe-learned", display_name: "Stripe (learned)", description: "Learned from a page, 2026." });
  bad({ name: "x\"><script>alert(1)</script>" }, /name/);
  bad({ name: "" }, /name/);
  bad({ description: "nice }body{color:red" }, /description/);
});

test("the banned set is refused anywhere: ; { } < url( \\ newline", () => {
  for (const v of ["#fff;", "#fff}", "#fff{", "<b>", "url(x)", "#f\\66f", "#fff\n"]) {
    bad({ colors: { primary: v } });
  }
});

test("layout (numbers only) is accepted as the shipped themes carry it", () => {
  ok({ layout: { viewport_width: 1280, content_start_x: 48 } });
  bad({ layout: { viewport_width: "1280px" } }, /layout\.viewport_width/);
});
