// deck-review.js — what a deck's review is made of, read from a version (DES-PRESENTATION-EDITOR-001
// I-D2, the approvals half). Pure: no I/O.
//
// A slide approval is given ON A VERSION, to the slide as it reads there (operator decision D5). It
// carries forward to a later version only when that slide's content hash there is unchanged; any
// other later version shows it as "approved on vN, changed since". The hash is the sha-256 of the
// slide's markup exactly as the version holds it, notes included: a move does not change it (the
// slide's own markup is the same), an edit to its words, colours or notes does.
//
// Approvals are review records, never delivery gates (D4): nothing here is read by a run's gates.

import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { SLIDE_ID_ATTR, topSlides } from "./deck.js";

export const DECISIONS = ["approved", "changes_requested"];
/** The audience presets a deck offers (D8), plus `custom` (the operator's own words in `label`). */
export const AUDIENCE_PRESETS = ["exec", "eng", "customer", "custom"];
export const NOTE_MAX = 2000;
export const LABEL_MAX = 200;

/**
 * Every top-level slide of a version, in document order: its id and its content hash. The hash covers
 * three things (codex r1-r3 on I-D2):
 *  - the slide's own markup;
 *  - the slide's context: the tag and attributes of each element above it, up to `<html>`;
 *  - everything outside the slides: the whole document, parsed as a document (so `<html>`/`<body>`
 *    attributes count), with every top-level slide taken out;
 *  - every stylesheet in the document, in document order (each styles the whole document).
 * A re-theme, a changed stylesheet (its `media`, its order), or a class on `<body>` or a wrapper
 * changes every slide's hash. Moving, inserting, deleting or duplicating a slide changes no other
 * slide's hash, and a move keeps the moved slide's own unless it lands under a different wrapper.
 * By design a slide's position is not in its hash (a move keeps its approval), so CSS that styles a
 * slide by its position (`:nth-child`) is outside what an approval checks.
 */
export function slideHashes(html) {
  const $ = cheerio.load(String(html));
  const slides = topSlides($).map((el) => ({
    slide_id: $(el).attr(SLIDE_ID_ATTR) ?? null,
    markup: $.html(el),
    context: $(el).parents().toArray().map((p) => `${p.tagName}${JSON.stringify(Object.entries(p.attribs ?? {}).sort())}`).join("<"),
  }));
  const sk = cheerio.load(String(html));
  // Every stylesheet styles the whole document, wherever it sits (codex r8): all of them, inside the
  // slides or not, are shared input IN DOCUMENT ORDER (codex r9: the cascade is that order) — so
  // changing or relocating one inside slide B is a change to slide A.
  const sheets = sk('style, link[rel~="stylesheet"]').toArray().map((el) => sk.html(el)).join("\u0000");
  for (const el of topSlides(sk)) sk(el).remove();
  // Whitespace between elements renders as at most one space (codex r4-r6): each whitespace-only text
  // node becomes one space and a run of them one node, so the line breaks a deleted slide leaves behind
  // never count. Nothing else is normalized: text, and everything inside `pre`, `textarea`, `style`
  // and `script` (a CSS string's spaces), stays exactly as written. Only HTML's collapsible whitespace
  // (space, tab, CR, LF, FF) is collapsed — never a no-break space (codex r7). Known limit: whitespace
  // that CSS makes significant on an ordinary element (`white-space: pre`) is collapsed too; judging
  // that needs the cascade, which a hash of the markup does not run.
  collapseWhitespace(sk.root()[0], false);
  const skeleton = sk.html();
  return slides.map((s) => ({
    slide_id: s.slide_id,
    hash: createHash("sha256").update(skeleton).update("\u0001").update(sheets).update("\u0001").update(s.context).update("\u0001").update(s.markup).digest("hex"),
  }));
}

const KEEP_WHITESPACE = new Set(["pre", "textarea", "style", "script"]);
function collapseWhitespace(node, keep) {
  let prevBlank = false;
  for (const ch of [...(node.children ?? [])]) {
    if (ch.type === "text" && !keep && /^[ \t\n\r\f]*$/.test(ch.data ?? "")) {
      // A run is one space: the rest of it is emptied in place (the tree is never re-linked here).
      ch.data = prevBlank ? "" : " ";
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    if (ch.children) collapseWhitespace(ch, keep || KEEP_WHITESPACE.has(String(ch.name ?? "").toLowerCase()));
  }
}

/** A stored decision row as it must read, or null (a hand-edited or damaged row is skipped — codex r1). */
export function decisionRow(d) {
  if (typeof d !== "object" || d === null) return null;
  if (typeof d.slide_id !== "string" || !Number.isInteger(d.version) || typeof d.hash !== "string") return null;
  if (![...DECISIONS, "cleared"].includes(d.decision)) return null;
  return d;
}

/**
 * The review of one version: each slide with the newest decision on it given on that version or one
 * it descends from (`lineage`: the version's ancestry, itself included — a decision never carries
 * BACK to a version it was not given on or before, nor across to a sibling fork; codex r1), and
 * whether that decision still holds here (`current`: same content hash). A decision for a slide id
 * the version does not have is not listed. `decisions` is the store's list, oldest first.
 */
export function reviewOf(slides, decisions, lineage) {
  const latest = new Map();
  for (const raw of decisions) {
    const d = decisionRow(raw);
    if (d === null || !lineage.has(d.version)) continue;
    latest.set(d.slide_id, d);
  }
  return slides.map((s) => {
    const d = s.slide_id === null ? undefined : latest.get(s.slide_id);
    return {
      slide_id: s.slide_id,
      hash: s.hash,
      decision: d === undefined || d.decision === "cleared" ? null : {
        decision: d.decision, version: d.version, note: typeof d.note === "string" ? d.note : null, at: typeof d.at === "string" ? d.at : null, current: d.hash === s.hash,
      },
    };
  });
}

/** Why a decision body cannot be recorded as given, or null. Shape only. */
export function decisionProblem(body) {
  if (typeof body !== "object" || body === null) return "a decision is an object";
  if (!Number.isInteger(body.version) || body.version < 0) return "version (the version the slide was reviewed on) is required";
  if (typeof body.slide_id !== "string" || body.slide_id === "") return "slide_id is required";
  if (![...DECISIONS, "cleared"].includes(body.decision)) return `decision must be one of ${[...DECISIONS, "cleared"].join(", ")}`;
  if (body.note !== undefined && body.note !== null && (typeof body.note !== "string" || body.note.length > NOTE_MAX)) return `note must be text of at most ${NOTE_MAX} characters`;
  return null;
}

/** Why an audience body cannot be recorded as given, or null. `custom` needs the operator's words. */
export function audienceProblem(body) {
  if (typeof body !== "object" || body === null) return "an audience is an object";
  if (!AUDIENCE_PRESETS.includes(body.preset)) return `preset must be one of ${AUDIENCE_PRESETS.join(", ")}`;
  if (body.label !== undefined && body.label !== null && (typeof body.label !== "string" || body.label.length > LABEL_MAX)) return `label must be text of at most ${LABEL_MAX} characters`;
  if (body.preset === "custom" && (typeof body.label !== "string" || body.label.trim() === "")) return "a custom audience needs its label";
  return null;
}
