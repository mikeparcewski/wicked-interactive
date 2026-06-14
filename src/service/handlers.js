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
import { grabUrlToPdf } from "./theme-grab.js";
import { resolveLearnedTheme } from "./theme-source.js";

/** Append a line to the doc's conversation transcript (ADR-0014). Best-effort. */
export function appendConversation(dir, entry) {
  try {
    appendFileSync(resolve(dir, "conversation.jsonl"),
      JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() }) + "\n");
  } catch { /* best-effort */ }
}

// Theme opts for a version-creation. An explicit ctx.themeOpts wins (incl. theme:false). Otherwise,
// if this doc has LEARNED a theme from a URL (<doc>/theme/learned.theme.json), re-theme with it so
// the learned brand sticks across every draft/edit/feedback version (ADR-0020) — no need to thread
// tokens through each event payload. Falls back to the named/default theme when no learned theme.
function themeOpts(ctx, dir) {
  const base = ctx.themeOpts || {};
  if (base.tokens || base.theme === false) return base;
  const learned = resolveLearnedTheme(dir);
  return learned ? { ...base, tokens: learned } : base;
}

/**
 * UI feedback batch → apply deterministic edits now, hand the structural remainder to the
 * agent via the emitted `wicked.feedback.processed` (with fragments inline — no request file).
 */
export async function materializeFeedback(dir, payload, ctx) {
  const { items, author } = payload;
  const { version, parent } = writeFeedback(dir, { items, author });
  const result = await applyFeedbackItems(dir, { version, parent, items }, themeOpts(ctx, dir));
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
  const out = await applyStructuralResults(dir, { version, results }, themeOpts(ctx, dir));
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
  const out = await applyGeneratedHtml(dir, html, themeOpts(ctx, dir));
  ctx.emit("wicked.version.created", {
    version: out.version, parent: out.parent, kind: "generated", html_file: `_v${out.version}.html`,
  });
  return out;
}

/** Demo (re-)record trigger → run the authored spec with Playwright, land the storyboard. */
export async function materializeDemo(dir, payload, ctx) {
  try {
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
  } catch (e) {
    ctx.emit("wicked.status.posted", {
      document_id: ctx.documentId, state: "error",
      message: `Recording failed: ${e.message}`,
    });
    throw e;
  }
}

// --- Learn-a-theme-from-a-URL (ADR-0010/ADR-0020): the deterministic service half.
// The grab is model-free — render the URL to a PDF in a per-doc runtime artifact dir (like
// recordings/) and announce the path. The agent reads that PDF with vision, synthesizes a theme
// JSON, and applies it via the theming seam (assist skill). The service never "reads the design".
const THEME_DIR = "theme";

/** Per-doc theme artifact path builder — exported so it's unit-testable without a real grab. */
export function themeArtifactPath(dir, ts = Date.now()) {
  return resolve(dir, THEME_DIR, `learned_${ts}.pdf`);
}

/**
 * Theme-learn trigger → render the URL to a PDF in the doc workspace, then announce its path via
 * `wicked.theme.learned`. Mirrors materializeDemo's shape. `grab` is injectable so tests don't
 * need a real browser/network. On failure we surface a `wicked.status.posted` {state:"error"}
 * rather than throwing into the command loop (which would retry/DLQ a non-retryable bad URL or a
 * missing Chrome).
 */
export async function materializeThemeRequested(dir, payload, ctx, { grab = grabUrlToPdf } = {}) {
  const url = String(payload.url || "").trim();
  const filePath = String(payload.path || "").trim();
  try {
    // Learn from a LOCAL file (PDF/image) the user pointed at: no grab — the file IS the render,
    // the agent reads it in place (nothing uploads, local-first). Announce it like a grabbed PDF.
    if (filePath) {
      const abs = resolve(filePath);
      if (!existsSync(abs)) throw new Error(`file not found: ${filePath}`);
      const ext = abs.toLowerCase().split(".").pop();
      if (!["pdf", "png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
        throw new Error(`learn-from-file needs a PDF or image (got .${ext})`);
      }
      const format = ext === "pdf" ? "pdf" : "image";
      ctx.emit("wicked.theme.learned", { path: abs, render_path: abs, format });
      return { path: abs, render_path: abs, format };
    }
    if (!url) throw new Error("a theme URL or file is required");
    // Validate http(s) up front (mirrors server.js's demo branch) so a bad-protocol URL fails
    // fast WITHOUT touching the filesystem or invoking the grab — grabUrlToPdf re-checks too.
    let u;
    try { u = new URL(url); } catch { throw new Error(`theme URL must be a valid http(s) URL: ${url}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`theme URL must be http or https: ${url}`);
    mkdirSync(resolve(dir, THEME_DIR), { recursive: true });
    const renderPath = themeArtifactPath(dir);
    ctx.emit("wicked.status.posted", { state: "working", message: "Grabbing the page to read its design…" });
    const { path } = await grab(url, renderPath);
    ctx.emit("wicked.theme.learned", { url, render_path: path, format: "pdf" });
    return { url, render_path: path };
  } catch (e) {
    ctx.emit("wicked.status.posted", { state: "error", message: `Couldn't grab that URL: ${e.message}` });
    return { error: e.message };
  }
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

/** UI removed a source from context → drop it from sources.json by path (persists the removal). */
export function materializeSourceRemoved(dir, payload) {
  const target = resolve(String(payload.path || "").trim());
  const sources = readSources(dir).filter((s) => s.path !== target);
  writeSources(dir, sources);
  return { sources };
}
