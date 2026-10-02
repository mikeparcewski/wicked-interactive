// theme-grammar.js — the per-field grammar a learned theme's tokens must fit (EP-I2).
//
// themeCss (theme.js) interpolates token values raw into CSS custom properties, and a learned
// theme is applied at EVERY version-creation for its doc (theme-source.js → handlers.js). The
// tokens come from reading a grabbed third-party page, which is prompt-injection material, so a
// value like `red;}body{background:url(https://x/?…)` would ride into every later version. Every
// value is therefore checked against a closed grammar per field, at the write route (PUT
// /api/theme/learned) AND at the reader (resolveLearnedTheme), so a file written any other way
// (an agent, a hand edit) is covered too. PURE: no I/O.
//
// Shape: the src/themes/*.json shape — `{name, display_name?, description?, colors, fonts, sizes,
// spacing, layout?, card}`, every group optional. Unknown top-level keys are refused.

const BANNED = /[;{}<\\\n\r]|url\(/i;

const NUM = String.raw`(?:\d{1,3}(?:\.\d+)?%?|\.\d+%?)`;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = new RegExp(String.raw`^(?:rgba?|hsla?)\(\s*${NUM}(?:\s*,\s*${NUM}){2,3}\s*\)$`, "i");
const WI_VAR = /^var\(--wi-[a-z0-9-]{1,40}\)$/;
const LENGTH = /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em|pt)$/;
// A shadow offset/blur: the strict length, a bare 0, or (offsets only) a negative length.
const SHADOW_LEN = /^(?:0|-?\d{1,3}(?:\.\d{1,2})?(?:px|rem|em|pt))$/;
const FAMILY = /^(?:[A-Za-z0-9 -]{1,64}|'[A-Za-z0-9 -]{1,64}'|"[A-Za-z0-9 -]{1,64}")$/;
const NAME = /^[A-Za-z0-9 _-]{1,64}$/;
const PROSE = /^[^<>{};\\\n\r]{0,200}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

export function isColor(v) {
  return typeof v === "string" && (HEX.test(v) || COLOR_FN.test(v) || WI_VAR.test(v));
}

export function isLength(v) {
  return typeof v === "string" && LENGTH.test(v);
}

export function isFontList(v) {
  if (typeof v !== "string" || v.length > 200) return false;
  const parts = v.split(",").map((p) => p.trim());
  return parts.length > 0 && parts.every((p) => p !== "" && FAMILY.test(p) && p.trim() === p);
}

// `none`, or up to two comma-separated `<len> <len> <len>? <colour>` shadows. Commas inside a
// colour function are not separators, so split on commas at depth 0 only.
export function isShadow(v) {
  if (typeof v !== "string" || v.length > 200) return false;
  if (v.trim() === "none") return true;
  const shadows = [];
  let depth = 0, cur = "";
  for (const ch of v) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return false;
    if (ch === "," && depth === 0) { shadows.push(cur); cur = ""; } else cur += ch;
  }
  if (depth !== 0) return false;
  shadows.push(cur);
  if (shadows.length > 2) return false;
  return shadows.every((raw) => {
    // `rgba(0, 0, 0, .1)` → `rgba(0,0,0,.1)` so a colour function is one token.
    const s = raw.replace(/\([^)]*\)/g, (fn) => fn.replace(/\s+/g, ""));
    const m = /^\s*(\S+)\s+(\S+)(?:\s+(\S+))?\s+(\S+(?:\([^)]*\))?)\s*$/.exec(s);
    if (!m) return false;
    const [, x, y, blur, color] = m;
    return SHADOW_LEN.test(x) && SHADOW_LEN.test(y) && (blur === undefined || SHADOW_LEN.test(blur))
      && isColor(color);
  });
}

// Per-group value checks. `keys: null` = any lowercase key, each value by `value`.
const GROUPS = {
  colors: { keys: null, value: isColor },
  fonts: { keys: null, value: isFontList },
  sizes: { keys: null, value: isLength },
  spacing: { keys: null, value: isLength },
  layout: { keys: null, value: (v) => typeof v === "number" && Number.isFinite(v) },
  card: {
    keys: { background: isColor, border_radius: isLength, padding: isLength, shadow: isShadow },
  },
};

const reject = (detail) => ({ ok: false, reason: `theme-rejected:${detail}` });
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Check a learned-theme token object. The first failing field decides.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkThemeTokens(tokens) {
  if (!isPlainObject(tokens)) return reject("not-an-object");
  for (const [key, val] of Object.entries(tokens)) {
    if (key === "name") {
      if (typeof val !== "string" || !NAME.test(val)) return reject("value-outside-grammar:name");
      continue;
    }
    if (key === "display_name" || key === "description") {
      if (typeof val !== "string" || !PROSE.test(val) || BANNED.test(val)) return reject(`value-outside-grammar:${key}`);
      continue;
    }
    const group = GROUPS[key];
    if (!group) return reject(`unknown-key:${String(key).slice(0, 40)}`);
    if (!isPlainObject(val)) return reject(`not-an-object:${key}`);
    for (const [sub, v] of Object.entries(val)) {
      const field = `${key}.${String(sub).slice(0, 40)}`;
      const check = group.keys ? group.keys[sub] : (KEY.test(sub) ? group.value : null);
      if (!check) return reject(`unknown-key:${field}`);
      if (typeof v === "string" && BANNED.test(v)) return reject(`value-outside-grammar:${field}`);
      if (!check(v)) return reject(`value-outside-grammar:${field}`);
    }
  }
  return { ok: true };
}
