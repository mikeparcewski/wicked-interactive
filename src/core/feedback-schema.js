// feedback-schema.js — parse/serialize the _v{x}.md feedback file (ADR-0002).
//
// File shape:
//   ---
//   version: 3
//   base_html: _v2.html
//   timestamp: 2026-05-26T18:00:00Z
//   author: jane            # optional
//   ---
//
//   ## item: slide-0-heading-1
//   - type: content-edit
//   - instruction: Rename the title
//   - before: Q2 Results
//   - value: Q3 Results
//
//   ## item: slide-0-paragraph-2
//   - type: style-edit
//   - before: ...
//   - style: { color: "#c00", font-weight: bold }
//   - class_add: [highlight]
//
// Per-type operation fields (ADR-0002 refinement):
//   content-edit       -> value
//   style-edit         -> style (map) and/or class_add[] / class_remove[]
//   structural-change  -> instruction (free text, LLM)

// js-yaml v5 is ESM-only and dropped the CommonJS default export; import the
// namespace so `yaml.load` / `yaml.dump` keep working (the functions themselves
// are API-compatible with v4).
import * as yaml from "js-yaml";

export const TYPES = ["content-edit", "style-edit", "structural-change", "remove"];

const ITEM_HEADING = /^##\s+item:\s*(.+?)\s*$/;
const FIELD = /^-\s+([a-z_]+):\s*([\s\S]*)$/;

function parseScalar(raw) {
  const t = raw.trim();
  if (t === "") return "";
  // Allow inline YAML for structured fields (maps/lists), fall back to string.
  if (/^[[{]/.test(t)) {
    try { return yaml.load(t); } catch { /* fall through */ }
  }
  return t;
}

/**
 * Parse a feedback markdown string.
 * @param {string} md
 * @returns {{ frontmatter: object, items: Array<object> }}
 */
export function parseFeedback(md) {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error("feedback file missing YAML frontmatter");
  const frontmatter = yaml.load(fmMatch[1]) || {};
  const body = fmMatch[2];

  const items = [];
  let current = null;
  for (const line of body.split("\n")) {
    const h = line.match(ITEM_HEADING);
    if (h) {
      if (current) items.push(finalizeItem(current));
      current = { selector: h[1], _fields: {} };
      continue;
    }
    if (!current) continue;
    const f = line.match(FIELD);
    if (f) current._fields[f[1]] = parseScalar(f[2]);
  }
  if (current) items.push(finalizeItem(current));

  for (const it of items) validateItem(it);
  return { frontmatter, items };
}

function finalizeItem({ selector, _fields }) {
  return {
    selector,
    type: _fields.type,
    instruction: _fields.instruction ?? null,
    before: _fields.before ?? null,
    value: _fields.value ?? null,
    style: _fields.style ?? null,
    class_add: normalizeList(_fields.class_add),
    class_remove: normalizeList(_fields.class_remove),
  };
}

function normalizeList(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function validateItem(it) {
  if (!it.selector) throw new Error("feedback item missing selector");
  if (!TYPES.includes(it.type)) {
    throw new Error(`feedback item ${it.selector}: invalid type ${JSON.stringify(it.type)}`);
  }
  if (it.type === "content-edit" && it.value == null) {
    throw new Error(`content-edit ${it.selector}: missing 'value'`);
  }
  if (it.type === "style-edit" && it.style == null && !it.class_add && !it.class_remove) {
    throw new Error(`style-edit ${it.selector}: needs 'style', 'class_add', or 'class_remove'`);
  }
  if (it.type === "structural-change" && !it.instruction) {
    throw new Error(`structural-change ${it.selector}: missing 'instruction'`);
  }
}

/** Serialize a feedback object back to the _v{x}.md format. */
export function serializeFeedback({ frontmatter, items }) {
  const fm = yaml.dump(frontmatter).trimEnd();
  const blocks = items.map((it) => {
    const lines = [`## item: ${it.selector}`, `- type: ${it.type}`];
    if (it.instruction != null) lines.push(`- instruction: ${it.instruction}`);
    if (it.before != null) lines.push(`- before: ${it.before}`);
    if (it.value != null) lines.push(`- value: ${it.value}`);
    if (it.style != null) lines.push(`- style: ${JSON.stringify(it.style)}`);
    if (it.class_add) lines.push(`- class_add: [${it.class_add.join(", ")}]`);
    if (it.class_remove) lines.push(`- class_remove: [${it.class_remove.join(", ")}]`);
    return lines.join("\n");
  });
  return `---\n${fm}\n---\n\n${blocks.join("\n\n")}\n`;
}
