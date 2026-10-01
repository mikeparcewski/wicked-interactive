// style-grammar.js — the declared property/value grammar a deterministic style-edit must fit (#247).
//
// A style-edit's map lands in the element's inline `style` and rides into every saved version and
// every self-contained HTML export. So it is checked against a closed grammar instead of being
// copied through: a property must be on the allowlist, and its value must tokenize fully into
// plain CSS tokens (identifiers, numbers with units, hex colours, simple quoted names, commas,
// arithmetic operators) with function calls limited to the colour/math functions below. Anything
// else — `url(`, `expression(`, `image-set(`, a `;`/`{`/`}` breakout, a CSS escape, `!important` —
// rejects the whole item with a reason; nothing is partially applied.

export const STYLE_PROPERTIES = new Set([
  "color", "background", "background-color", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-align", "text-decoration", "text-transform", "white-space",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-width", "border-style", "border-radius",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "display", "gap", "justify-content", "align-items", "flex-direction", "box-shadow",
]);

export const STYLE_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp"]);

const MAX_VALUE_LENGTH = 200;

// Ordered token patterns, matched sticky at the cursor. A function name is an ident immediately
// followed by "(" and is checked against STYLE_FUNCTIONS.
const TOKENS = [
  ["space", /\s+/y],
  ["func", /(-?[A-Za-z_][A-Za-z0-9_-]*)\(/y],
  ["ident", /-{0,2}[A-Za-z_][A-Za-z0-9_-]*/y],
  ["number", /[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|[A-Za-z]+)?/y],
  ["hash", /#[0-9A-Fa-f]{3,8}\b/y],
  ["string", /'[A-Za-z0-9 _-]*'|"[A-Za-z0-9 _-]*"/y],
  ["close", /\)/y],
  ["punct", /[,+*/-]/y],
];

const reject = (detail) => ({ ok: false, reason: `style-edit-rejected:${detail}` });

/** Check one declaration. @returns {{ok:true}|{ok:false, reason:string}} */
export function checkDeclaration(property, value) {
  if (typeof property !== "string" || !STYLE_PROPERTIES.has(property)) {
    return reject(`property-not-allowed:${String(property).slice(0, 60)}`);
  }
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return reject(`value-outside-grammar:${property}`);
  if (value.length > MAX_VALUE_LENGTH) return reject(`value-too-long:${property}`);
  let i = 0;
  let depth = 0;
  while (i < value.length) {
    let matched = false;
    for (const [kind, re] of TOKENS) {
      re.lastIndex = i;
      const m = re.exec(value);
      if (!m || m.index !== i) continue;
      if (kind === "func") {
        const name = m[1].toLowerCase();
        if (!STYLE_FUNCTIONS.has(name)) return reject(`function-not-allowed:${name}(`);
        depth += 1;
      } else if (kind === "close") {
        depth -= 1;
        if (depth < 0) return reject(`value-outside-grammar:${property}`);
      }
      i = re.lastIndex;
      matched = true;
      break;
    }
    if (!matched) return reject(`value-outside-grammar:${property}`);
  }
  if (depth !== 0) return reject(`value-outside-grammar:${property}`);
  return { ok: true };
}

/** Check a whole style map; the first failing declaration decides. */
export function checkStyleMap(styleMap) {
  if (styleMap == null || typeof styleMap !== "object" || Array.isArray(styleMap)) {
    return reject("style-not-a-map");
  }
  for (const [k, v] of Object.entries(styleMap)) {
    const r = checkDeclaration(k, v);
    if (!r.ok) return r;
  }
  return { ok: true };
}
