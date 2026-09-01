// server.js — the long-running local service (ADR-0005). It is model-free infrastructure:
// it serves versions, accepts the synchronous artifact commands (fork/export), and bridges
// the wicked-bus control plane to the browser (ADR-0019). It is NOT the intelligence — the
// supervising agent is (assist skill).
//
// Control plane = wicked-bus (ADR-0019). The browser can't read SQLite, so the service is
// the bridge: bus → SSE down (GET /api/events), a whitelisted POST /api/events up. The agent
// talks to the bus directly (wicked-bus subscribe/emit). State plane (versions, data-wid,
// fork model, INV-2) is unchanged — only the trigger/announce path moved to the bus.

import express from "express";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { emitEvent, busDb, startSubscription, closeBus } from "./bus-client.js";
import { PRODUCERS, ALL_FILTER, uiEmittable, isKnownType } from "./events.js";
import { appendConversation, materializeFeedback, materializeEdit, materializeDraft, materializeDemo, materializeSourceAttached, materializeSourceUpdated, materializeSourceRemoved, materializeThemeRequested } from "./handlers.js";
import { initWorkspace, forkVersion, loadManifest, readVersionHtml } from "./workspace.js";
import { saveManifest } from "./fsstore.js";
import { isRetired as manifestRetired, retireManifest } from "../core/versions.js";
import { REQUESTS_DIR } from "./structural.js";
import { generationPlaceholder } from "./generation.js";
import { demoPlaceholder, exportGif, RECORDINGS_DIR } from "./demo.js";
import { exportHtml, exportPdf } from "./export.js";
import { exportPptx } from "./pptx.js";
import { preflightWithCrew } from "./preflight.js";
import { listInstances } from "./instances.mjs";
import { pidAlive, LOCK_NAME, normalizeOrigin, readStudioOrigin, recordStudioOrigin } from "./serve-bridge.mjs";
import { bindDocToProject, projectIdFor } from "./project.js";
import { resolveLearnedTheme, learnedThemePath } from "./theme-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// The standalone SPA shell is retired (DES-MERGE-001 §6.4/§7.13): the bridge is API-only and the
// UI lives in the merged wicked-studio app. `--standalone` / WI_STANDALONE=1 keeps the old shell
// for development. Read per call so the CLI and tests can flip it without reloading the module.
const standaloneDefault = () => process.env.WI_STANDALONE === "1";

// Loopback check for the endpoints that are a LOCAL trust decision (the filesystem browser, the
// studio-origin record) — not something any origin that can reach the port gets to drive.
function isLocalRequest(req) {
  const ip = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "";
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// GET / with no studio origin recorded. The honest page: what this port is, where the UI went,
// and how to get the old shell back — never a bare 404 at someone who just wanted the UI.
function noStudioOriginPage(root) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>wicked-interactive — API-only bridge</title><style>
body{margin:0;padding:3rem 1.5rem;background:#0b1020;color:#e6e9f5;font:16px/1.6 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto}h1{font-size:1.5rem;margin:0 0 1rem}
code{background:#1b2340;padding:.15rem .4rem;border-radius:4px}
a{color:#8fb4ff}p{margin:0 0 1rem}
</style></head><body><main>
<h1>This is the wicked-interactive bridge — it serves the API, not the UI.</h1>
<p>The standalone builder UI has moved into the merged <strong>wicked-studio</strong> app; open your
document there. This service still answers every <code>/api/*</code> route (start at
<a href="/api/docs">/api/docs</a>), serving <code>${escapeHtml(root)}</code>.</p>
<p>No studio origin has been recorded in <code>${LOCK_NAME}</code> yet, so there is nothing to
redirect you to. wicked-crew records it when it starts or adopts this bridge; you can also record
it yourself with <code>POST /api/studio-origin {"origin":"http://localhost:4200"}</code> or start
the bridge with <code>--studio-origin &lt;url&gt;</code>.</p>
<p>Need the old shell for development? Start the service with <code>--standalone</code> (or
<code>WI_STANDALONE=1</code>).</p>
</main></body></html>`;
}

// Command events a per-doc workspace materializes (everything else on the bus — facts, chat,
// status, question.answered — is handled by the bridge or another subscriber, not here).
const COMMAND_TYPES = new Set([
  "wicked.interactive.feedback.submitted", "wicked.interactive.edit.completed", "wicked.interactive.draft.completed",
  "wicked.interactive.demo.requested", "wicked.interactive.theme.requested", "wicked.interactive.source.attached", "wicked.interactive.source.updated", "wicked.interactive.source.removed",
]);

/**
 * Build a per-document sub-app: state-plane reads, synchronous artifact commands, and a
 * `runCommand(event)` the multi-server's command loop drives. No SSE, no watcher — those
 * are the bus bridge's job (createMultiServer).
 *
 * @param {object} opts
 * @param {string} opts.dir            workspace directory (already initialised)
 * @param {string} [opts.documentId]
 * @param {(type:string, payload:object)=>any} [opts.emit]  service emit bound to this doc
 * @param {string} [opts.frontendDir]
 * @param {boolean} [opts.standalone]  serve the retired SPA shell (dev only, DES-MERGE-001 §7.13)
 */
export function createServer({ dir, documentId = "doc", emit = () => {}, frontendDir, standalone = standaloneDefault() } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // FIFO serialization (ADR-0007): process one mutation at a time so concurrent
  // regenerations never race on the manifest. Returns a promise reflecting THIS task so the
  // command loop can retry/DLQ on failure, while keeping the chain alive after an error.
  let queue = Promise.resolve();
  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  // Plugin install-gate (ADR-0016): which sibling tools are present.
  app.get("/api/preflight", async (_req, res) => res.json(await preflightWithCrew()));

  app.get("/api/versions", (_req, res) => {
    try { res.json(loadManifest(dir)); } catch (e) { res.status(404).json({ error: e.message }); }
  });

  function sendVersion(res, v) {
    try { res.type("html").send(readVersionHtml(dir, v)); }
    catch { res.status(404).send(`version ${v} not found`); }
  }
  app.get("/doc", (_req, res) => {
    try { sendVersion(res, loadManifest(dir).head); } catch (e) { res.status(404).send(e.message); }
  });
  app.get("/doc/:version", (req, res) => sendVersion(res, Number(req.params.version)));

  // Fork / "start again from here" (ADR-0008, AC-21): non-destructive. Enqueued so it can't
  // race a bus-driven regeneration on the manifest.
  app.post("/api/fork", (req, res) => {
    const from = Number(req.body?.from);
    if (!Number.isInteger(from)) return res.status(400).json({ error: "from (version number) required" });
    enqueue(async () => {
      const { version, parent } = forkVersion(dir, from);
      emit("wicked.interactive.version.created", { version, parent, kind: "fork", html_file: `_v${version}.html` });
      return { version, parent };
    }).then((r) => res.json(r)).catch((e) => res.status(400).json({ error: e.message }));
  });

  // Export to self-contained HTML or PDF (ADR-0009), triggered from the browser. POST creates
  // the file; the response carries a `download` URL the frontend hits to pull the bytes.
  app.post("/api/export", async (req, res) => {
    const version = Number(req.body?.version);
    const format = String(req.body?.format || "html").toLowerCase();
    if (!Number.isInteger(version)) return res.status(400).json({ error: "version (number) required" });
    if (!["html", "pdf", "pptx"].includes(format)) return res.status(400).json({ error: "format must be html, pdf, or pptx" });
    try {
      const result = format === "pdf" ? await exportPdf(dir, version)
        : format === "pptx" ? exportPptx(dir, version)
        : exportHtml(dir, version);
      const file = basename(result.path);
      const download = `${req.baseUrl || ""}/api/export/file/${encodeURIComponent(file)}`;
      emit("wicked.interactive.export.requested", { version, format });
      // Export gate: announce the freshly-rendered artifact + its on-disk path so the supervising
      // agent can vision-review it before the user trusts it (the agent replies wicked.interactive.export.reviewed).
      emit("wicked.interactive.export.generated", { version, format, path: result.path, file, download });
      res.json({ format, ...result, file, download });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Download the actual exported file. Filenames are restricted to the slug charset, so this
  // can't path-traverse. Content-Disposition forces a save dialog. dotfiles:"allow" because the
  // path is server-derived (docs root + validated name), and send's default "ignore" 404s any
  // absolute path with a dot-segment — e.g. a docs root under ~/.local/share or a .wicked/ worktree.
  app.get("/api/export/file/:name", (req, res) => {
    const name = req.params.name;
    // Leading dots rejected: with dotfiles:"allow" below, "." / ".." / ".hidden" would otherwise
    // reach sendFile ("." and ".." pass the charset test and resolve to DIRECTORIES).
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return res.status(400).send("invalid name");
    const filePath = join(dir, "exports", name);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return res.status(404).send("not found");
    const lower = name.toLowerCase();
    const type = lower.endsWith(".pdf") ? "application/pdf"
      : lower.endsWith(".pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "text/html; charset=utf-8";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.sendFile(filePath, { dotfiles: "allow" });
  });

  // Convert a recorded version's webm -> animated GIF (embeddable where video isn't). Lazy +
  // cached; a missing ffmpeg comes back as a 400 with an install hint rather than a crash.
  app.post("/api/demo/gif", (req, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) return res.status(400).json({ error: "version (number) required" });
    try {
      const { path, bytes, cached } = exportGif(dir, version);
      const name = basename(path);
      const download = `${req.baseUrl || ""}/api/demo/recording/${encodeURIComponent(name)}`;
      res.json({ ok: true, file: name, bytes, cached, download });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stream a recorded demo video / thumbnail / GIF. Path-locked to the slug charset.
  app.get("/api/demo/recording/:name", (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).send("invalid name");
    const filePath = join(dir, RECORDINGS_DIR, name);
    if (!existsSync(filePath)) return res.status(404).send("not found");
    const lower = name.toLowerCase();
    const type = lower.endsWith(".mp4") ? "video/mp4"
      : lower.endsWith(".webm") ? "video/webm"
      : lower.endsWith(".gif") ? "image/gif"
      : lower.endsWith(".png") ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
      : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.sendFile(filePath);
  });

  // Standalone HTML player for a recorded version — served into an iframe in the storyboard.
  // Using an iframe sidesteps React's cross-browser video element quirks entirely.
  app.get("/api/demo/player/:version", (req, res) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 0) return res.status(400).send("invalid version");
    const base = `/d/${documentId}`;
    const mp4 = `${base}/api/demo/recording/_v${version}.mp4`;
    const webm = `${base}/api/demo/recording/_v${version}.webm`;
    const poster = `${base}/api/demo/recording/_v${version}-poster.jpg`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#0b1020;overflow:hidden}
.c{position:relative;width:100%;height:100%}
video{width:100%;height:100%;display:block;object-fit:contain}
#btn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:72px;height:72px;border-radius:50%;
  background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.5);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;transition:background .15s;pointer-events:all}
#btn:hover{background:rgba(255,255,255,.3)}
#btn svg{margin-left:5px}
#btn.gone{display:none}
</style></head><body>
<div class="c">
  <video id="v" controls poster="${poster}">
    <source src="${mp4}" type="video/mp4">
    <source src="${webm}" type="video/webm">
  </video>
  <div id="btn" onclick="go()"><svg width="30" height="30" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div>
</div>
<script>
const v=document.getElementById('v'),btn=document.getElementById('btn');
function go(){v.play();btn.classList.add('gone');}
v.addEventListener('play',()=>btn.classList.add('gone'));
v.addEventListener('pause',()=>{if(v.currentTime>0&&!v.ended)btn.classList.remove('gone');});
v.addEventListener('ended',()=>btn.classList.remove('gone'));
</script>
</body></html>`);
  });

  // Conversation transcript (ADR-0014): written by the bus bridge (chat/status), read here.
  app.get("/api/conversation", (_req, res) => {
    try {
      const f = resolve(dir, "conversation.jsonl");
      const lines = existsSync(f) ? readFileSync(f, "utf-8").trim() : "";
      res.json(lines ? lines.split("\n").map((l) => JSON.parse(l)) : []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sources (ADR-0017): the list, materialized into requests/sources.json by the command
  // handlers. The browser only reads it (and emits wicked.interactive.source.attached to add more).
  app.get("/api/sources", (_req, res) => {
    try {
      const f = resolve(dir, REQUESTS_DIR, "sources.json");
      const parsed = existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : { sources: [] };
      res.json({ sources: Array.isArray(parsed?.sources) ? parsed.sources : [] });
    } catch { res.json({ sources: [] }); }
  });

  // Learned-theme readback (#180): what did "learn a theme" produce for this doc? The agent
  // writes <dir>/theme/learned.theme.json (assist Step 8.5) and the version-creation seam
  // re-applies it silently — but nothing could READ it over HTTP, which is why studio's
  // brand-learn accent mapper was retracted (studio#73). Read-only, no side effects: serve the
  // CURRENT file through the same resolver the apply seam uses (resolveLearnedTheme), so what
  // this returns is exactly what version-creation will apply — a corrupt/absent file is a 404
  // here precisely because the apply seam degrades to the named/default theme for it.
  // `learned_at` is the file's mtime — when the learn last landed; advisory, null if unstattable.
  app.get("/api/theme/learned", (_req, res) => {
    res.set("Cache-Control", "no-store");   // consumers poll this right after a learn — never stale
    const tokens = resolveLearnedTheme(dir);
    if (!tokens) return res.status(404).json({ error: "no learned theme" });
    let learned_at = null;
    try { learned_at = statSync(learnedThemePath(dir)).mtime.toISOString(); }
    catch { /* mtime is advisory — the tokens are the contract */ }
    res.json({ document_id: documentId, learned_at, tokens });
  });

  // Local filesystem browser for the path picker (localhost-only; dotfiles hidden).
  app.get("/api/fs", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "local only" });
    const home = homedir();
    const target = resolve((req.query?.path || "").toString().trim() || home);
    try {
      const st = statSync(target);
      if (!st.isDirectory()) return res.status(400).json({ error: "not a directory" });
      const entries = readdirSync(target, { withFileTypes: true })
        .filter((d) => !d.name.startsWith("."))
        .map((d) => {
          let isDir = d.isDirectory();
          if (d.isSymbolicLink()) { try { isDir = statSync(join(target, d.name)).isDirectory(); } catch { isDir = false; } }
          return { name: d.name, path: join(target, d.name), dir: isDir };
        })
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      const parent = dirname(target);
      res.json({ path: target, parent: parent === target ? null : parent, home, entries });
    } catch (e) {
      const code = e.code === "EACCES" ? 403 : e.code === "ENOENT" ? 404 : 500;
      res.status(code).json({ error: e.message });
    }
  });

  // Materialize a command event on the FIFO. Returns a promise reflecting success/failure
  // so the bus subscriber can retry/DLQ. `emit` is already bound to this doc's identity.
  function runCommand(event) {
    const p = event.payload || {};
    const ctx = { emit, documentId, dir };
    switch (event.event_type) {
      case "wicked.interactive.feedback.submitted": return enqueue(() => materializeFeedback(dir, p, ctx));
      case "wicked.interactive.edit.completed":     return enqueue(() => materializeEdit(dir, p, ctx));
      case "wicked.interactive.draft.completed":    return enqueue(() => materializeDraft(dir, p, ctx));
      case "wicked.interactive.demo.requested":     return enqueue(() => materializeDemo(dir, p, ctx));
      case "wicked.interactive.theme.requested":    return enqueue(() => materializeThemeRequested(dir, p, ctx));
      case "wicked.interactive.source.attached":    return enqueue(() => materializeSourceAttached(dir, p));
      case "wicked.interactive.source.updated":     return enqueue(() => materializeSourceUpdated(dir, p));
      case "wicked.interactive.source.removed":     return enqueue(() => materializeSourceRemoved(dir, p));
      default: return Promise.resolve();
    }
  }

  // The retired SPA shell, dev-only behind --standalone (DES-MERGE-001 §7.13). Mounted after
  // the API routes; without the flag this sub-app serves its API surface and nothing else.
  if (standalone) {
    const staticDir = frontendDir || resolve(HERE, "../../frontend/dist");
    if (existsSync(staticDir)) app.use(express.static(staticDir));
  }

  let server;
  async function start(port = 0) {
    return new Promise((res) => { server = app.listen(port, () => res(server.address().port)); });
  }
  async function stop() {
    if (server) await new Promise((r) => server.close(r));
  }

  return { app, start, stop, enqueue, runCommand, emit, dir, documentId };
}

// ---------------------------------------------------------------------------
// Multi-document mode (ADR-0015): one express server hosting many workspaces under a docs
// root, each mounted at /d/:doc/. Owns the single wicked-bus connection (ADR-0019): the SSE
// bridge down, the UI-emit bridge up, and the command loop that materializes events.
// ---------------------------------------------------------------------------

const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/; // slug-safe, no path separators

function slugify(name) {
  return String(name || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

/** Create a multi-doc server. `root` is the parent dir holding one subdir per doc. */
export function createMultiServer({ root, frontendDir, standalone = standaloneDefault() } = {}) {
  if (!root) throw new Error("createMultiServer: root is required");
  mkdirSync(root, { recursive: true });
  const top = express();
  top.use(express.json({ limit: "5mb" }));

  const docs = new Map();   // name -> { svc, dir }
  let topServer;
  const SESSION_ID = randomUUID();   // server lifetime; stamped on UI emits for tracing
  const subs = [];          // bus subscription handles (stopped on shutdown)
  const processedKeys = new Set();   // in-process command idempotency (at-least-once dedupe)

  function docDir(name) { return resolve(root, name); }
  function isExistingDoc(name) {
    return DOC_NAME.test(name) && existsSync(join(docDir(name), "versions.json"));
  }

  // Retirement tombstone (#189): `retired_at` stamped on versions.json by DELETE /api/docs/:doc.
  // SOFT retire, deliberately: this engine's versions are write-once (INV-4) and the fork model
  // promises "nothing is removed" (AC-22), so retiring must not shred a lineage that evidence and
  // audits may still point at — the doc leaves every LIVE surface (listing, /d/ routes, the UI
  // emit bridge, command materialization) while its files stay on disk, readable by an operator
  // and re-listable via ?includeRetired. Reads the manifest per call (same posture as listDocs);
  // an unreadable/absent manifest is simply "not retired" — the existing unknown-doc paths answer.
  // @returns {{retired_at:string}|null}
  function retiredInfo(name) {
    if (!DOC_NAME.test(name)) return null; // also keeps arbitrary path segments away from disk
    try {
      const m = loadManifest(docDir(name));
      return manifestRetired(m) ? { retired_at: m.retired_at } : null;
    } catch { return null; }
  }

  // ── Browser SSE bridge (down) ─────────────────────────────────────────────
  // One stream of bus envelopes (replaces the old per-doc + cross-doc SSE streams). The frontend
  // routes on event_type and filters on payload.document_id. 15s heartbeat keeps proxies +
  // any downstream watchdog warm; setNoDelay defeats Nagle on the tiny comment frames.
  const sseClients = new Set();
  function bridgeSend(event) {
    const frame = `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch { /* dead socket; close handler clears */ } }
  }
  top.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    res.write("event: ready\ndata: {}\n\n");
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* cleared on close */ } }, 15_000);
    const cleanup = () => { clearInterval(heartbeat); sseClients.delete(res); };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // The service emit, bound to a doc's identity. Stamps document_id + producer so the
  // ownership table + loop-safety (consumers drop their own producer) hold.
  function serviceEmit(documentId) {
    // Additive project enrichment (DES-PROJECT-001 §2.3): a doc bound to a crew project carries
    // its `project_id` on every service-emitted payload (version.created, export.generated, …).
    // The breadcrumb is the doc-side hint — advisory, read per emit (docs emit rarely); an
    // unbound doc's payloads are byte-identical to before this field existed.
    //
    // DERIVED, never caller-supplied: the binding is a fact about the DOC, so a payload's own
    // project_id is dropped — bound docs get the breadcrumb's id (applied after the spread so it
    // cannot be overridden), unbound docs carry none. Anything else would let one emit site
    // forge attribution into another project's activity feed.
    return (type, payload) => {
      const projectId = projectIdFor(docDir(documentId));
      const enriched = { document_id: documentId, ...payload };
      delete enriched.project_id;
      if (projectId) enriched.project_id = projectId;
      return emitEvent(type, enriched, { producer: PRODUCERS.SERVICE });
    };
  }

  // Retired-doc gate for every per-doc route (#189), registered BEFORE any doc app is mounted
  // (mounts happen at bootstrap/request time, always after construction) so it fires first for
  // docs retired in this process AND for tombstones already on disk at boot. 410 Gone with a JSON
  // body — a service refusal that says WHY, never Express's route-missing text (the exact failure
  // mode the issue pinned).
  top.use("/d/:doc", (req, res, next) => {
    const tomb = retiredInfo(String(req.params.doc || ""));
    if (tomb) return res.status(410).json({ error: "doc retired", document_id: req.params.doc, retired_at: tomb.retired_at });
    next();
  });

  async function mountDoc(name) {
    if (docs.has(name)) return docs.get(name);
    if (!isExistingDoc(name)) throw new Error(`unknown or invalid doc: ${name}`);
    if (retiredInfo(name)) throw new Error(`doc retired: ${name}`);
    const dir = docDir(name);
    const svc = createServer({ dir, documentId: name, emit: serviceEmit(name), frontendDir: null, standalone });
    top.use(`/d/${name}`, svc.app);
    docs.set(name, { svc, dir });
    return docs.get(name);
  }

  // Retired docs are EXCLUDED by default (#189) — the tombstone's whole point is leaving the
  // picker — with `includeRetired` as the audit escape hatch; a retired row carries
  // `retired: true, retired_at` so a client can render it as history, while live rows stay
  // byte-identical to before retirement existed.
  function listDocs({ includeRetired = false } = {}) {
    const out = [];
    for (const entry of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!DOC_NAME.test(name)) continue;
      const v = join(docDir(name), "versions.json");
      if (!existsSync(v)) continue;
      try {
        const m = JSON.parse(readFileSync(v, "utf-8"));
        if (manifestRetired(m) && !includeRetired) continue;
        const last = m.versions[m.versions.length - 1] || {};
        out.push({
          name, kind: m.kind || "doc", head: m.head, versions: m.versions.length, updated_at: last.created_at || null,
          ...(manifestRetired(m) ? { retired: true, retired_at: m.retired_at } : {}),
        });
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  // ── Bus handlers ──────────────────────────────────────────────────────────
  // Bridge: fan every event to SSE clients, and persist chat/status to the doc transcript
  // (single logger, so no double-logging). Best-effort — never throws into the subscribe loop.
  // Last durably-appended status text per doc (#160): crew HEARTBEATS its narration on an
  // interval to keep the liveness window fed, so identical consecutive status.posted frames are
  // a pulse, not new conversation — the SSE bridge above still relays every frame (the canvas
  // indicator stays live), but the transcript and thread record each narration once. In-memory
  // on purpose: a restart forgetting the last line costs at most one duplicate entry.
  const lastStatusText = new Map();
  // Last FULL status frame per doc (#165) — pulses included, unlike the transcript above. A
  // remounting frontend (nav back / reload mid-build) reads it via GET /api/docs/:doc/activity
  // to rehydrate the working indicator instead of waiting for the next bus frame. In-memory on
  // purpose (same contract as lastStatusText): a restart forgetting it degrades to the crew-run
  // probe below, never to a wrong answer.
  const lastStatus = new Map();
  function onBridge(event) {
    bridgeSend(event);
    const name = event.payload?.document_id;
    if (!name || !DOC_NAME.test(name)) return;
    const dir = docDir(name);
    try {
      if (event.event_type === "wicked.interactive.chat.posted") {
        appendConversation(dir, { role: event.payload.role, text: event.payload.text });
        lastStatusText.delete(name); // real conversation separates status repeats
      } else if (event.event_type === "wicked.interactive.status.posted") {
        const { message, question, state } = event.payload;
        lastStatus.set(name, {
          state: state ?? null,
          message: message ?? null,
          question: question ?? null,
          options: Array.isArray(event.payload.options) ? event.payload.options : [],
          request_id: event.payload.request_id ?? null,
          at: typeof event.payload.ts === "string" ? event.payload.ts : new Date().toISOString(),
        });
        // Bounded like lastStatusText: evict oldest past 500 docs (insertion order is Map order).
        if (lastStatus.size > 500) lastStatus.delete(lastStatus.keys().next().value);
        // 'working' statuses are the run's PULSE (#164) — they render in the live indicator via
        // SSE and never enter the durable transcript; only major transitions (pickup, questions,
        // errors, completion) are conversation.
        if (state === "working") return;
        const text = question || message;
        if (text && lastStatusText.get(name) !== text) {
          appendConversation(dir, { role: "agent", text, state });
          lastStatusText.set(name, text);
          // Bounded (Copilot): evict oldest past 500 docs — insertion order is Map order.
          if (lastStatusText.size > 500) {
            lastStatusText.delete(lastStatusText.keys().next().value);
          }
        }
      }
    } catch { /* transcript logging is best-effort */ }
  }

  // Commands: materialize state. Drops our own facts (loop safety) and non-command types.
  // Throwing propagates to the subscribe loop -> retry -> DLQ.
  async function onCommand(event) {
    if (event.producer_id === PRODUCERS.SERVICE) return;
    if (!COMMAND_TYPES.has(event.event_type)) return;
    const key = event.idempotency_key;
    if (key && processedKeys.has(key)) return;
    const name = event.payload?.document_id;
    if (!name || !DOC_NAME.test(name)) return;
    if (retiredInfo(name)) return;  // retired doc (#189) — the tombstone is final; ack, don't DLQ
    let entry = docs.get(name);
    if (!entry && isExistingDoc(name)) entry = await mountDoc(name);
    if (!entry) return;  // unknown doc — nothing to materialize against
    await entry.svc.runCommand(event);
    if (key) processedKeys.add(key);
  }

  // ── Top-level endpoints ─────────────────────────────────────────────────────
  // Identity probe (ADR-0022): says WHICH instance this is (the docs root it serves) so a
  // launching agent can tell "my bridge is already up" from "someone else is on this port".
  top.get("/api/health", (_req, res) => res.json({ ok: true, root, pid: process.pid, port: topServer?.address?.().port ?? null }));
  // Crew projects for the creation wizard's picker (#162): docs must be project-bound to route
  // through the governed crew, and the ONLY place a browser user can bind is at creation. Proxied
  // here (same-origin) because the frontend cannot call the crew API cross-origin. `available:
  // false` (crew down/absent) renders the wizard without a picker — the assist-only path.
  const crewApiBase = () => (process.env.WICKED_CREW_API || "http://127.0.0.1:7701").replace(/\/+$/, "");
  top.get("/api/crew/projects", async (_req, res) => {
    const base = crewApiBase();
    try {
      const r = await fetch(`${base}/api/v1/projects`, { signal: AbortSignal.timeout(750) });
      if (!r.ok) return res.json({ available: false, projects: [] });
      const body = await r.json();
      const projects = (body.projects || [])
        .filter((p) => p.status !== "archived" && p.id !== "default")
        .map((p) => ({ id: p.id, name: p.name }));
      return res.json({ available: true, projects });
    } catch {
      return res.json({ available: false, projects: [] });
    }
  });
  // Create a project from the wizard (#167). The picker can only bind to projects that already
  // exist, so a first-run user with an empty crew had nowhere to file a doc. Pure passthrough —
  // crew stays the authority on the id, the name rules, and the lifecycle; we mint nothing and
  // forward its refusal verbatim so the wizard can show the real reason.
  top.post("/api/crew/projects", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "a project name is required" });
    const base = crewApiBase();
    try {
      const r = await fetch(`${base}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(750),
      });
      const body = await r.json().catch(() => ({}));
      // A 4xx is crew judging the REQUEST (bad name, duplicate) — keep its status so the user
      // sees "you" not "us"; anything else is crew failing, which is a 502 from here.
      if (!r.ok) {
        const status = r.status >= 400 && r.status < 500 ? r.status : 502;
        return res.status(status).json({ error: body.error || `crew rejected the project (${r.status})` });
      }
      const project = body.project || body;
      if (!project?.id) return res.status(502).json({ error: "crew returned no project id" });
      return res.json({ id: project.id, name: project.name || name });
    } catch {
      return res.status(502).json({ error: "crew is unreachable — create the doc without a project, or start crew" });
    }
  });
  // Doc build activity (#165): is a build in flight for this doc? A frontend that remounts
  // mid-build (nav back, reload, new tab) asks this on doc open and rehydrates the working
  // indicator instead of waiting for the next bus frame. Two additive sources:
  //  • the last status.posted frame this service bridged (lastStatus — pulses included), and
  //  • crew's run list: the doc→run association is the problem-statement marker BOTH crew
  //    seams stamp verbatim (`the wicked-interactive document "<name>"` — draft-events.ts /
  //    edit-events.ts), scanned for a run in a non-terminal state.
  // Crew down/absent/slow degrades to the status snapshot alone — never an error (same silent
  // contract as GET /api/crew/projects): this read happens on every doc open.
  const RUN_ACTIVE_STATUSES = new Set(["planning", "distributing", "executing", "awaiting_human"]);
  const PULSE_FRESH_MS = 60_000; // crew heartbeats narration every ≤15s — a fresh pulse means live work
  // Shared by GET /api/docs/:doc/activity and DELETE /api/docs/:doc (the in-flight gate, #189).
  async function activityFor(name) {
    const status = lastStatus.get(name) || null;
    let run = null;
    try {
      const r = await fetch(`${crewApiBase()}/api/v1/runs`, { signal: AbortSignal.timeout(750) });
      if (r.ok) {
        const body = await r.json();
        const marker = `the wicked-interactive document "${name}"`;
        const hit = (body.runs || []).find((v) =>
          typeof v?.session?.problem === "string" && v.session.problem.includes(marker) &&
          RUN_ACTIVE_STATUSES.has(v.session.status));
        if (hit) run = { id: hit.session.id, workflow_id: hit.session.workflow_id, status: hit.session.status };
      }
    } catch { /* crew unreachable — the status snapshot is still the honest answer */ }
    // Active = crew reports a live run, OR the last pulse is fresh (covers the assist-skill
    // answerer, which has no crew run, and a crew API the service can't reach).
    const at = status ? Date.parse(status.at) : NaN;
    const pulseFresh = !!status && status.state === "working" &&
      Number.isFinite(at) && Date.now() - at < PULSE_FRESH_MS;
    return { active: !!run || pulseFresh, status, run };
  }
  top.get("/api/docs/:doc/activity", async (req, res) => {
    const name = String(req.params.doc || "");
    if (!docs.has(name) && !isExistingDoc(name)) return res.status(404).json({ error: "unknown doc" });
    const tomb = retiredInfo(name);
    if (tomb) return res.status(410).json({ error: "doc retired", document_id: name, retired_at: tomb.retired_at });
    res.json({ document_id: name, ...(await activityFor(name)) });
  });
  // The running instances the UI's project switcher can jump between (ADR-0025 follow-up). Live
  // pids only; the current root is flagged + sorted first. Each `serve` registers itself on start.
  top.get("/api/projects", (_req, res) => {
    const here = resolve(root);
    const projects = listInstances({ isAlive: pidAlive })
      .map((i) => ({ root: i.root, name: i.name, port: i.port, version: i.version,
        url: `http://localhost:${i.port}/`, current: resolve(i.root) === here }))
      .sort((a, b) => (a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1));
    res.json({ root: here, projects });
  });
  top.get("/api/preflight", async (_req, res) => res.json(await preflightWithCrew()));
  top.get("/api/docs", (req, res) => {
    const includeRetired = ["1", "true"].includes(String(req.query?.includeRetired ?? "").toLowerCase());
    res.json(listDocs({ includeRetired }));
  });

  // Retire a doc (#189): the unmake half of POST /api/docs. SOFT retire — see retiredInfo() for
  // why hard deletion is the wrong verb for this engine (write-once versions, INV-4/AC-22): the
  // tombstone lands in versions.json, the doc leaves the default listing and every live surface,
  // the lineage stays on disk for audit, and the name stays reserved (a recreated "q3-report"
  // silently inheriting an old doc's audit trail would be worse than a 409).
  //
  // In-flight work (issue decision, spelled out so a client can say it out loud): REFUSE with the
  // reason — 409 carrying the same {status, run} shape as GET /api/docs/:doc/activity. Cancel-then-
  // delete would put this bridge in the business of killing crew runs it doesn't own.
  //
  // Idempotent: retiring a retired doc is 200 with `already_retired: true` and the ORIGINAL
  // retired_at (no second event). Unknown or invalid name: 404, JSON body.
  top.delete("/api/docs/:doc", async (req, res) => {
    const name = String(req.params.doc || "");
    if (!isExistingDoc(name)) return res.status(404).json({ error: "unknown doc" });

    const answer = (m, { already, event_id } = {}) => res.json({
      name, kind: m.kind || "doc", retired: true, already_retired: !!already,
      retired_at: m.retired_at, head: m.head, versions: m.versions.length,
      ...(event_id != null ? { event_id } : {}),
    });

    try {
      if (retiredInfo(name)) return answer(loadManifest(docDir(name)), { already: true });

      const activity = await activityFor(name);
      if (activity.active) {
        return res.status(409).json({
          error: "doc has a build in flight — wait for it to finish (or cancel the run in crew), then retire",
          document_id: name, active: true, run: activity.run, status: activity.status,
        });
      }

      // Serialize the tombstone write on the doc's FIFO (ADR-0007) so it can't race a
      // materializing command's manifest read-modify-write.
      const entry = docs.get(name) || await mountDoc(name);
      const outcome = await entry.svc.enqueue(() => {
        const { manifest, retired_at, already } = retireManifest(loadManifest(docDir(name)));
        if (!already) saveManifest(docDir(name), manifest);
        return { manifest, retired_at, already };
      });

      // Off every live surface: the /d/:doc gate answers 410 from here on (the mounted app stays
      // in the express stack but is unreachable behind it); the maps forget the doc.
      docs.delete(name);
      lastStatus.delete(name);
      lastStatusText.delete(name);

      let event_id;
      if (!outcome.already) {
        // The observable unmake fact (project_id enriched for bound docs, like every service emit)
        // — crew cleans its draft ledger on it; open canvases learn the doc is gone.
        ({ event_id } = await serviceEmit(name)("wicked.interactive.doc.retired", {
          retired_at: outcome.retired_at, kind: outcome.manifest.kind || "doc", versions: outcome.manifest.versions.length,
        }));
      }
      return answer(outcome.manifest, { already: outcome.already, event_id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Studio origin (DES-MERGE-001 §7.13). The shell is retired, so GET / redirects to the merged
  // studio app — and the bridge owns .wi-serve.json, so crew records the origin it serves that
  // app from THROUGH here, on start or when it adopts an already-running bridge. Loopback-only:
  // the redirect target is a local trust decision, not one any reachable client gets to make.
  top.get("/api/studio-origin", (_req, res) => res.json({ studio_origin: readStudioOrigin(root) }));
  top.post("/api/studio-origin", (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: "local only" });
    const wanted = normalizeOrigin(req.body?.origin);
    if (!wanted) return res.status(400).json({ error: "origin must be an http(s) URL" });
    const stored = recordStudioOrigin(root, wanted);
    if (!stored) return res.status(409).json({ error: `no ${LOCK_NAME} to record into — is this bridge serving a writable root?` });
    res.json({ ok: true, studio_origin: stored });
  });

  // UI emit bridge (up): the browser may only originate the whitelisted intent events. We
  // enrich with the UI producer + a fresh correlation id (per user action) + session id.
  top.post("/api/events", async (req, res) => {
    const type = String(req.body?.event_type || "");
    const payload = req.body?.payload || {};
    if (!isKnownType(type)) return res.status(400).json({ error: `unknown event type: ${type}` });
    if (!uiEmittable(type)) return res.status(403).json({ error: `not a UI-emittable event: ${type}` });
    const name = String(payload.document_id || "");
    if (!docs.has(name) && !isExistingDoc(name)) return res.status(404).json({ error: "unknown doc" });
    const tomb = retiredInfo(name);
    if (tomb) return res.status(410).json({ error: "doc retired", document_id: name, retired_at: tomb.retired_at });
    try {
      const correlationId = randomUUID();
      // Same additive enrichment as serviceEmit: UI-originated events (feedback.submitted, …)
      // for a project-bound doc carry its project_id (DES-PROJECT-001 §2.3). DERIVED ONLY — a
      // browser-supplied project_id is dropped, bound or not, so a client cannot spoof a doc
      // into (or out of) a project's activity feed; the breadcrumb is the one source.
      const projectId = projectIdFor(docDir(name));
      const enriched = { ...payload };
      delete enriched.project_id;
      if (projectId) enriched.project_id = projectId;
      const { event_id } = await emitEvent(type, enriched, { producer: PRODUCERS.UI, correlationId, sessionId: SESSION_ID });
      res.json({ ok: true, event_id, correlation_id: correlationId });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  top.post("/api/docs", async (req, res) => {
    const raw = req.body?.name;
    const kind = String(req.body?.kind || "").toLowerCase();
    const fromSource = kind === "source";
    const isDemo = kind === "demo";
    const sourcePaths = (Array.isArray(req.body?.source_paths) ? req.body.source_paths : [])
      .map((s) => String(s).trim()).filter(Boolean);
    const brief = String(req.body?.brief ?? "").trim();
    const demoUrl = String(req.body?.url ?? "").trim();
    const style = ["web", "ppt", "brochure", "doc"].includes(req.body?.style) ? req.body.style : null;
    const name = DOC_NAME.test(raw) ? raw : slugify(raw);
    if (!name || !DOC_NAME.test(name)) return res.status(400).json({ error: "valid name required (lowercase letters, digits, hyphens; up to 64 chars)" });
    if (isExistingDoc(name)) {
      // A retired name stays reserved (#189): its tombstoned lineage still answers to this name,
      // and a fresh doc silently inheriting an old audit trail would be a lie. Distinct message
      // so a client can explain WHICH kind of taken this is.
      if (retiredInfo(name)) return res.status(409).json({ error: "doc name is retired — its tombstoned lineage keeps the name reserved", name, retired: true });
      return res.status(409).json({ error: "doc already exists", name });
    }

    // Optional crew-project binding (DES-PROJECT-001 §2.3): registration is the AUTHORITY and it
    // happens FIRST — a doc that cannot be filed (unknown/archived project, no daemon reachable)
    // is a loud error with NO doc created, never a queued intent. A membership that briefly
    // predates its doc dir is fine by contract (members may predate what they point to); the
    // reverse — a doc the caller believes is filed but isn't — is the failure §2.2 forbids.
    // No `project` field ⇒ none of this runs: the offline solo-creator loop is untouched.
    const projectId = String(req.body?.project ?? "").trim();
    // Binds through here so BOTH creation branches share one contract: the dir must exist for
    // the breadcrumb, but a FAILED bind must leave no trace — the dir is removed again when
    // this call (not a later step) created it. "Nothing created on a refused bind" is literal.
    const bindProject = projectId
      ? async (dir, title) => {
          const existed = existsSync(dir);
          mkdirSync(dir, { recursive: true });
          try {
            await bindDocToProject({ dir, docName: name, projectId, meta: { title } });
          } catch (e) {
            if (!existed) rmSync(dir, { recursive: true, force: true });
            throw e;
          }
          return { project_id: projectId };
        }
      : null;
    if (bindProject) {
      // Validate reachability + attachability up-front (cheap GET) so the create fails BEFORE
      // any disk write when the binding can never succeed.
      try {
        const { assertProjectAttachable, resolveCrewApi } = await import("./project.js");
        await assertProjectAttachable(resolveCrewApi(), projectId);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }

    // Demo (ADR-0018): seed a placeholder storyboard v0, emit wicked.interactive.doc.created(kind:demo).
    // The agent explores the app, authors demo.spec.mjs, then emits wicked.interactive.demo.requested.
    if (isDemo) {
      let u;
      try { u = new URL(demoUrl); } catch { return res.status(400).json({ error: "a valid http(s) url is required for a demo" }); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return res.status(400).json({ error: "demo url must be http or https" });
      try {
        const dir = docDir(name);
        // Registration precedes any doc content; bindProject owns the dir lifecycle (creates it
        // for the breadcrumb, removes it again on a refused bind).
        const bound = bindProject ? await bindProject(dir, name) : null;
        initWorkspace(dir, demoPlaceholder(name, demoUrl, brief), { kind: "demo" });
        await mountDoc(name);
        await emitEvent("wicked.interactive.doc.created", { document_id: name, kind: "demo", url: demoUrl, brief, ...(bound ?? {}) }, { producer: PRODUCERS.SERVICE });
        return res.json({ name, head: 0, kind: "demo", learning: true, ...(bound ?? {}) });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // "From my content" (ADR-0010): seed a placeholder v0, emit wicked.interactive.doc.created(kind:source).
    // The agent indexes the source(s)/brief and emits wicked.interactive.draft.completed with the first draft.
    if (fromSource && sourcePaths.length === 0 && !brief) return res.status(400).json({ error: "add at least one source path or a brief" });
    const html = fromSource
      ? (String(req.body?.html ?? "") || generationPlaceholder(name, sourcePaths, brief))
      : String(req.body?.html ?? "");
    if (!fromSource && !html.trim()) return res.status(400).json({ error: "html required" });

    try {
      const dir = docDir(name);
      // Registration (the authority) precedes content; bindProject owns the dir lifecycle.
      const bound = bindProject ? await bindProject(dir, name) : null;
      initWorkspace(dir, html);
      await mountDoc(name);
      // Seed the original ask as the first conversation entry — the durable "intent" the Intent
      // review (semantic-reviewer) checks the current version against. Best-effort.
      if (brief) appendConversation(dir, { role: "user", text: brief });
      const docKind = fromSource ? "source" : (kind || "html");
      await emitEvent("wicked.interactive.doc.created",
        { document_id: name, kind: docKind, ...(fromSource ? { source_paths: sourcePaths, brief } : {}), ...(style ? { style } : {}), ...(bound ?? {}) },
        { producer: PRODUCERS.SERVICE });
      res.json({ name, head: 0, ...(fromSource ? { generating: true } : {}), ...(bound ?? {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Mount docs already on disk so their routes are live from the first request.
  async function bootstrap() {
    for (const entry of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])) {
      // Tombstoned docs stay unmounted (#189) — the /d/:doc gate would 410 them anyway.
      if (entry.isDirectory() && isExistingDoc(entry.name) && !retiredInfo(entry.name)) await mountDoc(entry.name);
    }
  }

  // Where a `?doc=` bookmark lands in the merged app: a project-bound doc has a home in studio's
  // route map (DES-MERGE-001 §1.5); an unbound (or unknown) one lands on the board.
  function studioPathFor(doc) {
    const name = String(doc ?? "");
    if (!DOC_NAME.test(name) || !isExistingDoc(name) || retiredInfo(name)) return "/";
    const projectId = projectIdFor(docDir(name));
    return projectId ? `/p/${encodeURIComponent(projectId)}/document/${encodeURIComponent(name)}` : "/";
  }

  // The root, mounted LAST so /api/* and /d/* take precedence. API-only by default
  // (DES-MERGE-001 §6.4/§7.13): GET / redirects to the studio origin recorded in the lockfile,
  // and with none recorded it says so in plain words rather than 404ing at someone who wanted a
  // UI. --standalone restores the retired SPA shell for development.
  if (standalone) {
    const staticDir = frontendDir || resolve(HERE, "../../frontend/dist");
    if (existsSync(staticDir)) top.use(express.static(staticDir));
  } else {
    top.get("/", (req, res) => {
      res.set("Cache-Control", "no-store");   // never cache a hop to an origin that can move
      const origin = readStudioOrigin(root);
      if (!origin) return res.type("html").send(noStudioOriginPage(root));
      res.redirect(302, origin + studioPathFor(req.query?.doc));
    });
  }

  async function start(port = 0) {
    await bootstrap();
    busDb(); // fail-fast: open the bus before we accept traffic (ADR-0021)
    // Two subscriptions on the one bus: the bridge (fan-out + transcript, best-effort) and
    // the command loop (materialize, retry+DLQ). cursor_init "latest" — live events only.
    subs.push(startSubscription({ plugin: "wi-service-bridge", filter: ALL_FILTER, handler: onBridge, maxRetries: 0 }));
    subs.push(startSubscription({ plugin: "wi-service-commands", filter: ALL_FILTER, handler: onCommand, maxRetries: 2 }));
    return new Promise((res, rej) => {
      topServer = top.listen(port, () => res(topServer.address().port));
      topServer.once("error", rej); // surface EADDRINUSE as a rejection so the CLI can fall forward (ADR-0022)
    });
  }
  async function stop() {
    for (const s of subs) { try { await s.stop(); } catch { /* already stopped */ } }
    subs.length = 0;
    for (const { svc } of docs.values()) { try { await svc.stop(); } catch { /* not listening */ } }
    if (topServer) await new Promise((r) => topServer.close(r));
    for (const res of sseClients) { try { res.end(); } catch {} }
    sseClients.clear();
    closeBus();
  }

  return { app: top, start, stop, mountDoc, listDocs, get docCount() { return docs.size; } };
}
