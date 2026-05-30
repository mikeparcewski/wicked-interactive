// demo.js — the "demo" doc kind (ADR-0018): point wicked-interactive at a running app,
// the supervising agent learns it and authors a deterministic Playwright spec, and this
// model-free service EXECUTES that spec and RECORDS it. The recording + an anchored
// storyboard become a normal version, so the same feedback -> regenerate -> hot-reload
// loop applies (highlight a step, ask for a change, the agent re-authors the spec, the
// service re-records — deterministic replay, just like every other version).
//
// The split mirrors ADR-0003 (hybrid) and ADR-0010 (model-free delegation):
//   • Agent (intelligence): explores the URL, writes demo.spec.mjs (the steps).
//   • Service (deterministic infra): owns the browser launch, video capture, tracing,
//     artifact paths, versioning. It never decides WHAT to click — only runs the script.

import { mkdirSync, readdirSync, renameSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { instrument } from "../core/instrument.js";
import { themed } from "./theme-source.js";
import { recordVersion, nextVersionNumber } from "../core/versions.js";
import { atomicWrite, loadManifest, saveManifest } from "./fsstore.js";

export const REQUESTS_DIR = "requests";
export const DEMO_REQUEST = "_demo.request.json";
export const RECORDINGS_DIR = "recordings";
// The agent authors this file: a plain ES module exporting `meta` (url, title, steps[])
// and `async run({ page, step, meta })`. The service supplies page/step; the agent only
// expresses the click-path. Kept out of the version artifacts (it's the source, not output).
export const DEMO_SPEC = "demo.spec.mjs";

// Escapes the full set so the same helper is safe in both text and attribute (href/src)
// contexts — the target URL and title are rendered into attributes in storyboard().
const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Placeholder storyboard shown at v0 while the agent learns the app and authors the spec. */
export function demoPlaceholder(name, url, brief = "") {
  const title = esc((name || "your demo").replace(/-/g, " "));
  const briefBlock = brief ? `<blockquote>${esc(brief)}</blockquote>` : "";
  return (
    `<section class="wi-demo">` +
      `<h1>Learning ${esc(url)}…</h1>` +
      `<p class="lead">Exploring the app and authoring the click-path for <b>${title}</b>. ` +
      `When the first recording is ready it will appear right here — then highlight any ` +
      `step to refine it.</p>` +
      briefBlock +
    `</section>`
  );
}

/**
 * Write the demo work request for a freshly-created demo doc. The agent watches for this
 * file (or the `demo` SSE event), learns the target app, authors demo.spec.mjs, then calls
 * POST /api/demo/record to have the service execute + record it.
 */
export function writeDemoRequest(dir, { url, brief = "", documentId = dir }) {
  mkdirSync(join(dir, REQUESTS_DIR), { recursive: true });
  const body = {
    document_id: documentId,
    url: String(url).trim(),
    brief: String(brief).trim(),
    spec_file: DEMO_SPEC,
    ts: new Date().toISOString(),
  };
  atomicWrite(join(dir, REQUESTS_DIR, DEMO_REQUEST), JSON.stringify(body, null, 2));
  return { requestFile: DEMO_REQUEST };
}

/**
 * Build the storyboard HTML for a recorded demo: the embedded video plus an anchored,
 * ordered step list. The step blocks are the feedback targets (data-wid is assigned by
 * instrument() when the version lands), so a user can highlight "step 3" and ask for a
 * change exactly as they would any other block.
 *
 * The video src is a root-absolute path to this doc's locked recording endpoint, so it
 * resolves correctly regardless of which version path the iframe is currently showing.
 */
export function storyboard({ documentId, title, url, videoFile, steps = [] }) {
  const rec = (file) => `/d/${documentId}/api/demo/recording/${encodeURIComponent(file)}`;
  const videoSrc = rec(videoFile);
  // YouTube-style chapters: a clickable thumbnail per step that seeks the video to that
  // step's start time (data-seek, wired by the inline script below). The thumbnail is the
  // frame captured at the end of the step (its resulting view); the time is the chapter start.
  const chapters = steps.length
    ? `<ol class="wi-demo__chapters">` +
        steps.map((s, i) => {
          const t = Number.isFinite(s.at) ? s.at : 0;
          const thumb = s.thumb
            ? `<img src="${rec(s.thumb)}" alt="${esc(s.label)}" loading="lazy">`
            : `<span class="wi-demo__thumb-ph" aria-hidden="true">${i + 1}</span>`;
          return (
            `<li>` +
              `<button class="wi-demo__chapter" type="button" data-seek="${t}" title="Jump to ${esc(s.label)}">` +
                `<span class="wi-demo__thumb">${thumb}<span class="wi-demo__badge">${fmtTime(t)}</span></span>` +
                `<span class="wi-demo__cap"><span class="wi-demo__idx">${i + 1}</span>` +
                `<span class="wi-demo__name">${esc(s.label)}</span></span>` +
              `</button>` +
            `</li>`
          );
        }).join("") +
      `</ol>`
    : `<p class="wi-demo__nosteps">No steps were recorded.</p>`;
  // Self-contained layout: the iframe loads the raw version HTML, so it never sees the
  // app-shell stylesheet. Inline the demo styles here (using theme vars with fallbacks)
  // so the video renders full-width in the iframe AND in exported HTML.
  const style =
    `<style>` +
    `.wi-demo{max-width:920px;margin:0 auto;padding:8px 4px 40px;}` +
    `.wi-demo__head{margin-bottom:18px;}` +
    `.wi-demo__target{color:var(--wi-text-secondary,#64748B);font-size:14px;margin-top:4px;}` +
    `.wi-demo__target a{color:var(--wi-accent,#0891B2);text-decoration:none;}` +
    `.wi-demo__player{margin:0 0 22px;border-radius:8px;overflow:hidden;background:#0b1020;}` +
    `.wi-demo__player video{display:block;width:100%;height:auto;background:#0b1020;}` +
    `.wi-demo__chaptitle{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--wi-text-secondary,#64748B);margin:0 0 12px;}` +
    `.wi-demo__chapters{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;}` +
    `.wi-demo__chapter{display:flex;flex-direction:column;text-align:left;width:100%;padding:0;border:1px solid var(--wi-border,#E2E8F0);border-radius:10px;overflow:hidden;background:var(--wi-card-bg,#FFFFFF);color:inherit;font:inherit;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease;}` +
    `.wi-demo__chapter:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.12);border-color:var(--wi-accent,#0891B2);}` +
    `.wi-demo__chapter:focus-visible{outline:2px solid var(--wi-accent,#0891B2);outline-offset:2px;}` +
    `.wi-demo__thumb{position:relative;display:block;width:100%;aspect-ratio:16/9;background:#0b1020;}` +
    `.wi-demo__thumb img{display:block;width:100%;height:100%;object-fit:cover;}` +
    `.wi-demo__thumb-ph{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#475569;font-size:28px;font-weight:700;}` +
    `.wi-demo__badge{position:absolute;right:6px;bottom:6px;background:rgba(11,16,32,.85);color:#fff;font-size:12px;font-variant-numeric:tabular-nums;padding:2px 6px;border-radius:4px;}` +
    `.wi-demo__cap{display:flex;gap:8px;align-items:baseline;padding:10px 12px;}` +
    `.wi-demo__idx{font-size:12px;font-weight:700;color:var(--wi-accent,#0891B2);font-variant-numeric:tabular-nums;}` +
    `.wi-demo__name{font-weight:600;color:var(--wi-text,#1E293B);font-size:14px;line-height:1.3;}` +
    `.wi-demo__nosteps{color:var(--wi-text-secondary,#64748B);font-style:italic;}` +
    `</style>`;
  // Seek wiring: clicking a chapter sets the video to its start time and plays. Kept inline
  // so it travels with the self-contained export. No external deps.
  const script =
    `<script>(function(){` +
    `var v=document.getElementById("wi-demo-video");if(!v)return;` +
    `var cs=document.querySelectorAll(".wi-demo__chapter");` +
    `for(var i=0;i<cs.length;i++){(function(b){b.addEventListener("click",function(){` +
    `var t=parseFloat(b.getAttribute("data-seek"))||0;try{v.currentTime=t;}catch(e){}` +
    `v.play().catch(function(){});` +
    `v.scrollIntoView({behavior:"smooth",block:"start"});` +
    `});})(cs[i]);}` +
    `})();</script>`;
  return (
    `<section class="wi-demo">` +
      style +
      `<header class="wi-demo__head">` +
        `<h1>${esc(title || "Demo")}</h1>` +
        `<p class="wi-demo__target">Recorded against <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` +
      `</header>` +
      `<div class="wi-demo__player">` +
        `<video id="wi-demo-video" controls playsinline preload="metadata" src="${videoSrc}"></video>` +
      `</div>` +
      `<p class="wi-demo__chaptitle">Chapters</p>` +
      chapters +
      script +
    `</section>`
  );
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Execute the agent-authored spec with Playwright and record it, landing a new version
 * whose HTML is the storyboard. Deterministic: same spec -> same click-path. The service
 * owns the browser/recording lifecycle; the spec only supplies the steps.
 *
 * @param {string} dir   the demo workspace directory
 * @param {object} opts
 * @param {Function} [opts.emit]        HTML_UPDATED emitter (so the browser hot-reloads)
 * @param {string}   [opts.documentId]  doc name (used for the recording URL + events)
 * @param {Function} [opts.onStep]      progress callback ({ index, total, label })
 * @param {boolean}  [opts.headless]    default true
 * @returns {Promise<{version:number, parent:number, video:string, steps:Array}>}
 */
export async function recordDemo(dir, opts = {}) {
  const documentId = opts.documentId ?? dir;
  const specPath = join(dir, DEMO_SPEC);
  if (!existsSync(specPath)) throw new Error(`no ${DEMO_SPEC} authored yet — the agent must write the spec before recording`);

  // Resolve Playwright lazily so the service runs fine without it until a demo is recorded
  // (the install gate, ADR-0016, blocks demo creation until Playwright is present).
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed — run `npx playwright install` (the install gate should have caught this)");
  }

  // Cache-bust the import so a re-authored spec is picked up (ESM caches by URL).
  const spec = await import(`${pathToFileURL(specPath).href}?t=${Date.now()}`);
  const meta = spec.meta || {};
  const url = String(meta.url || "").trim();
  if (typeof spec.run !== "function") throw new Error(`${DEMO_SPEC} must export an async run({ page, step, meta })`);

  const recDir = join(dir, RECORDINGS_DIR);
  mkdirSync(recDir, { recursive: true });
  const manifest = loadManifest(dir);
  const version = nextVersionNumber(manifest);
  const videoFile = `_v${version}.webm`;
  const traceFile = `_v${version}.trace.zip`;

  const browser = await chromium.launch({ headless: opts.headless !== false });
  const stepTimings = [];
  const startedAt = Date.now();
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: recDir, size: { width: 1280, height: 720 } },
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();

    // `step` annotates a labelled segment so the storyboard can show ordered, timed steps
    // and so a failure points at the exact step. The agent wraps each action in step().
    let index = 0;
    const step = async (label, fn) => {
      index += 1;
      const at = (Date.now() - startedAt) / 1000;
      const entry = { label: String(label), at };
      stepTimings.push(entry);
      opts.onStep?.({ index, label: String(label), at });
      if (typeof fn === "function") await fn();
      // Chapter thumbnail (YouTube-style): capture the step's resulting view after its action
      // + dwell. The seek target stays `at` (chapter start); the frame is the post-action
      // state, which reads best as a thumbnail. A thumbnail is nice-to-have — never fail over it.
      const thumb = `_v${version}.step${String(index).padStart(2, "0")}.png`;
      try {
        await page.screenshot({ path: join(recDir, thumb) });
        entry.thumb = thumb;
      } catch { /* skip thumbnail */ }
    };

    await spec.run({ page, step, meta });

    await context.tracing.stop({ path: join(recDir, traceFile) });
    const pageVideo = page.video();
    await page.close();
    await context.close(); // flushes the video to disk
    context = null;

    // Playwright names the video with a random id; resolve the real path, then rename to
    // our deterministic per-version filename so the storyboard + endpoint are predictable.
    let produced = null;
    try { produced = pageVideo ? await pageVideo.path() : null; } catch { produced = null; }
    if (!produced) produced = newestWebm(recDir, startedAt);
    if (produced && existsSync(produced) && produced !== join(recDir, videoFile)) {
      renameSync(produced, join(recDir, videoFile));
    }
  } finally {
    if (context) { try { await context.close(); } catch { /* already closing */ } }
    await browser.close();
  }

  const html = storyboard({
    documentId,
    title: meta.title || documentId,
    url,
    videoFile,
    steps: stepTimings,
  });

  let m = loadManifest(dir);
  const parent = m.head;
  const prepared = themed(instrument(html).html, opts);
  atomicWrite(join(dir, `_v${version}.html`), prepared);
  ({ manifest: m } = recordVersion(m, { version, parent, feedbackFile: null }));
  saveManifest(dir, m);

  opts.emit?.("HTML_UPDATED", {
    document_id: documentId,
    version, html_file: `_v${version}.html`, prev_version: parent, ts: new Date().toISOString(),
  });

  return { version, parent, video: videoFile, steps: stepTimings };
}

/** Newest .webm written into `dir` since `sinceMs` — fallback when page.video() path is unavailable. */
function newestWebm(dir, sinceMs) {
  let best = null, bestMtime = sinceMs - 1000;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".webm")) continue;
    const full = join(dir, f);
    try {
      const mt = statSync(full).mtimeMs;
      if (mt >= bestMtime) { bestMtime = mt; best = full; }
    } catch { /* skip */ }
  }
  return best;
}
