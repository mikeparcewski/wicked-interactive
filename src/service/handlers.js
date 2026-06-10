// handlers.js — materialize command events into workspace state (ADR-0019).
//
// The command loop (createMultiServer) routes each inbound command event to one of these,
// serialized on the target doc's FIFO (ADR-0007). Handlers are the ONLY place the service
// mutates a workspace in response to the bus; they call the deterministic core functions
// (workspace/structural/generation/demo) and then emit the resulting fact(s) via `ctx.emit`.
//
// `ctx.emit(type, payload)` is bound to the service producer + this doc's document_id by the
// caller, so handlers never have to thread identity. Handlers return a small summary (useful
// in tests); side effects are the version files + the emitted facts.
//
// State plane unchanged: every version still lands write-once through instrument + theme +
// the INV-2 gate exactly as before. Only the trigger (an event, not a watched file) is new.

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFeedback, applyFeedbackItems } from "./workspace.js";
import { applyStructuralResults, REQUESTS_DIR } from "./structural.js";
import { applyGeneratedHtml } from "./generation.js";
import { recordDemo } from "./demo.js";

/** Append a line to the doc's conversation transcript (ADR-0014). Best-effort. */
export function appendConversation(dir, entry) {
  try {
    appendFileSync(resolve(dir, "conversation.jsonl"),
      JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() }) + "\n");
  } catch { /* best-effort */ }
}

const themeOpts = (ctx) => ctx.themeOpts || {};

/**
 * UI feedback batch → apply deterministic edits now, hand the structural remainder to the
 * agent via the emitted `wicked.feedback.processed` (with fragments inline — no request file).
 */
export async function materializeFeedback(dir, payload, ctx) {
  const { items, author } = payload;
  const { version, parent } = writeFeedback(dir, { items, author });
  const result = await applyFeedbackItems(dir, { version, parent, items }, themeOpts(ctx));
  if (!result.idempotent) {
    ctx.emit("wicked.version.created", {
      version, parent, kind: "deterministic", html_file: result.html_file,
    });
  }
  ctx.emit("wicked.feedback.processed", {
    version, applied: result.applied, rejected: result.rejected, stale: result.stale,
    awaiting_structural: result.structural_items.length,
    structural_items: result.structural_items,
  });
  return { version, ...result };
}

/** Agent structural results → follow-on version (INV-2 gate). */
export async function materializeEdit(dir, payload, ctx) {
  const { version, results } = payload;
  const out = await applyStructuralResults(dir, { version, results }, themeOpts(ctx));
  ctx.emit("wicked.version.created", {
    version: out.version, parent: out.parent, kind: "structural", html_file: `_v${out.version}.html`,
  });
  return out;
}

/** Agent first draft → land it as a new version. html inline, or html_path on disk (ADR-0019 D5). */
export async function materializeDraft(dir, payload, ctx) {
  let html = payload.html;
  if ((html == null || html === "") && payload.html_path) {
    html = readFileSync(resolve(payload.html_path), "utf-8");
  }
  const out = await applyGeneratedHtml(dir, html, themeOpts(ctx));
  ctx.emit("wicked.version.created", {
    version: out.version, parent: out.parent, kind: "generated", html_file: `_v${out.version}.html`,
  });
  return out;
}

/** Demo (re-)record trigger → run the authored spec with Playwright, land the storyboard. */
export async function materializeDemo(dir, payload, ctx) {
  const result = await recordDemo(dir, {
    documentId: ctx.documentId,
    headless: payload.headless !== false,
    onStep: ({ index, total, label }) => ctx.emit("wicked.status.posted", {
      state: "working", message: `Step ${index}${total ? `/${total}` : ""}: ${label}`,
    }),
  });
  ctx.emit("wicked.version.created", {
    version: result.version, parent: result.parent, kind: "demo", html_file: `_v${result.version}.html`,
  });
  return result;
}

// --- Sources (ADR-0017): the service persists sources.json so GET /api/sources is correct on
// reload; the bridge forwards source.attached / source.updated to the UI + agent directly, so
// no extra "sources" broadcast is needed (the events ARE the update).
const SOURCES_FILE = (dir) => resolve(dir, REQUESTS_DIR, "sources.json");
function readSources(dir) {
  try {
    const f = SOURCES_FILE(dir);
    if (!existsSync(f)) return [];
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return Array.isArray(parsed?.sources) ? parsed.sources : [];
  } catch { return []; }
}
function writeSources(dir, sources) {
  mkdirSync(resolve(dir, REQUESTS_DIR), { recursive: true });
  writeFileSync(SOURCES_FILE(dir), JSON.stringify({ sources }, null, 2));
}

/** UI attached reference paths → persist as pending (dedupe by absolute path). */
export function materializeSourceAttached(dir, payload) {
  const added = Array.isArray(payload.added) ? payload.added : [];
  const sources = readSources(dir);
  const known = new Set(sources.map((s) => s.path));
  for (const a of added) {
    const path = resolve(String(a.path || "").trim());
    if (!path || known.has(path)) continue;
    known.add(path);
    sources.push({ path, note: a.note || "", status: "pending", added_at: new Date().toISOString(), indexed_at: null });
  }
  writeSources(dir, sources);
  return { sources };
}

/** Agent index-status update → persist (pending→indexing→indexed|error). */
export function materializeSourceUpdated(dir, payload) {
  const target = resolve(String(payload.path || "").trim());
  const sources = readSources(dir);
  const entry = sources.find((s) => s.path === target);
  if (!entry) return { sources, unknown: true };
  entry.status = payload.status;
  if (payload.status === "indexed") entry.indexed_at = new Date().toISOString();
  writeSources(dir, sources);
  return { sources };
}
