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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { emitEvent, busDb, startSubscription, closeBus } from "./bus-client.js";
import { PRODUCERS, ALL_FILTER, uiEmittable, isKnownType } from "./events.js";
import { appendConversation, materializeFeedback, materializeEdit, materializeDraft, materializeDemo, materializeSourceAttached, materializeSourceUpdated, materializeSourceRemoved, materializeThemeRequested } from "./handlers.js";
import { initWorkspace, forkVersion, loadManifest, readVersionHtml } from "./workspace.js";
import { REQUESTS_DIR } from "./structural.js";
import { generationPlaceholder } from "./generation.js";
import { demoPlaceholder, exportGif, RECORDINGS_DIR } from "./demo.js";
import { exportHtml, exportPdf } from "./export.js";
import { exportPptx } from "./pptx.js";
import { preflight } from "./preflight.js";
import { listInstances } from "./instances.mjs";
import { pidAlive } from "./serve-bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Command events a per-doc workspace materializes (everything else on the bus — facts, chat,
// status, question.answered — is handled by the bridge or another subscriber, not here).
const COMMAND_TYPES = new Set([
  "wicked.feedback.submitted", "wicked.edit.completed", "wicked.draft.completed",
  "wicked.demo.requested", "wicked.theme.requested", "wicked.source.attached", "wicked.source.updated", "wicked.source.removed",
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
 */
export function createServer({ dir, documentId = "doc", emit = () => {}, frontendDir } = {}) {
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
  app.get("/api/preflight", (_req, res) => res.json(preflight()));

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
      emit("wicked.version.created", { version, parent, kind: "fork", html_file: `_v${version}.html` });
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
      emit("wicked.export.requested", { version, format });
      // Export gate: announce the freshly-rendered artifact + its on-disk path so the supervising
      // agent can vision-review it before the user trusts it (the agent replies wicked.export.reviewed).
      emit("wicked.export.generated", { version, format, path: result.path, file, download });
      res.json({ format, ...result, file, download });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Download the actual exported file. Filenames are restricted to the slug charset, so this
  // can't path-traverse. Content-Disposition forces a save dialog.
  app.get("/api/export/file/:name", (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).send("invalid name");
    const filePath = join(dir, "exports", name);
    if (!existsSync(filePath)) return res.status(404).send("not found");
    const lower = name.toLowerCase();
    const type = lower.endsWith(".pdf") ? "application/pdf"
      : lower.endsWith(".pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "text/html; charset=utf-8";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.sendFile(filePath);
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
  // handlers. The browser only reads it (and emits wicked.source.attached to add more).
  app.get("/api/sources", (_req, res) => {
    try {
      const f = resolve(dir, REQUESTS_DIR, "sources.json");
      const parsed = existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : { sources: [] };
      res.json({ sources: Array.isArray(parsed?.sources) ? parsed.sources : [] });
    } catch { res.json({ sources: [] }); }
  });

  // Local filesystem browser for the path picker (localhost-only; dotfiles hidden).
  function isLocalRequest(req) {
    const ip = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip === "";
  }
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
      case "wicked.feedback.submitted": return enqueue(() => materializeFeedback(dir, p, ctx));
      case "wicked.edit.completed":     return enqueue(() => materializeEdit(dir, p, ctx));
      case "wicked.draft.completed":    return enqueue(() => materializeDraft(dir, p, ctx));
      case "wicked.demo.requested":     return enqueue(() => materializeDemo(dir, p, ctx));
      case "wicked.theme.requested":    return enqueue(() => materializeThemeRequested(dir, p, ctx));
      case "wicked.source.attached":    return enqueue(() => materializeSourceAttached(dir, p));
      case "wicked.source.updated":     return enqueue(() => materializeSourceUpdated(dir, p));
      case "wicked.source.removed":     return enqueue(() => materializeSourceRemoved(dir, p));
      default: return Promise.resolve();
    }
  }

  // Serve the built React app at / (production). Mounted after API routes.
  const staticDir = frontendDir || resolve(HERE, "../../frontend/dist");
  if (existsSync(staticDir)) app.use(express.static(staticDir));

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
export function createMultiServer({ root, frontendDir } = {}) {
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
    return (type, payload) => emitEvent(type, { document_id: documentId, ...payload }, { producer: PRODUCERS.SERVICE });
  }

  async function mountDoc(name) {
    if (docs.has(name)) return docs.get(name);
    if (!isExistingDoc(name)) throw new Error(`unknown or invalid doc: ${name}`);
    const dir = docDir(name);
    const svc = createServer({ dir, documentId: name, emit: serviceEmit(name), frontendDir: null });
    top.use(`/d/${name}`, svc.app);
    docs.set(name, { svc, dir });
    return docs.get(name);
  }

  function listDocs() {
    const out = [];
    for (const entry of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!DOC_NAME.test(name)) continue;
      const v = join(docDir(name), "versions.json");
      if (!existsSync(v)) continue;
      try {
        const m = JSON.parse(readFileSync(v, "utf-8"));
        const last = m.versions[m.versions.length - 1] || {};
        out.push({ name, kind: m.kind || "doc", head: m.head, versions: m.versions.length, updated_at: last.created_at || null });
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  // ── Bus handlers ──────────────────────────────────────────────────────────
  // Bridge: fan every event to SSE clients, and persist chat/status to the doc transcript
  // (single logger, so no double-logging). Best-effort — never throws into the subscribe loop.
  function onBridge(event) {
    bridgeSend(event);
    const name = event.payload?.document_id;
    if (!name || !DOC_NAME.test(name)) return;
    const dir = docDir(name);
    try {
      if (event.event_type === "wicked.chat.posted") {
        appendConversation(dir, { role: event.payload.role, text: event.payload.text });
      } else if (event.event_type === "wicked.status.posted") {
        const { message, question, state } = event.payload;
        if (message || question) appendConversation(dir, { role: "agent", text: question || message, state });
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
  top.get("/api/preflight", (_req, res) => res.json(preflight()));
  top.get("/api/docs", (_req, res) => res.json(listDocs()));

  // UI emit bridge (up): the browser may only originate the whitelisted intent events. We
  // enrich with the UI producer + a fresh correlation id (per user action) + session id.
  top.post("/api/events", async (req, res) => {
    const type = String(req.body?.event_type || "");
    const payload = req.body?.payload || {};
    if (!isKnownType(type)) return res.status(400).json({ error: `unknown event type: ${type}` });
    if (!uiEmittable(type)) return res.status(403).json({ error: `not a UI-emittable event: ${type}` });
    const name = String(payload.document_id || "");
    if (!docs.has(name) && !isExistingDoc(name)) return res.status(404).json({ error: "unknown doc" });
    try {
      const correlationId = randomUUID();
      const { event_id } = await emitEvent(type, payload, { producer: PRODUCERS.UI, correlationId, sessionId: SESSION_ID });
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
    if (isExistingDoc(name)) return res.status(409).json({ error: "doc already exists", name });

    // Demo (ADR-0018): seed a placeholder storyboard v0, emit wicked.doc.created(kind:demo).
    // The agent explores the app, authors demo.spec.mjs, then emits wicked.demo.requested.
    if (isDemo) {
      let u;
      try { u = new URL(demoUrl); } catch { return res.status(400).json({ error: "a valid http(s) url is required for a demo" }); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return res.status(400).json({ error: "demo url must be http or https" });
      try {
        const dir = docDir(name);
        initWorkspace(dir, demoPlaceholder(name, demoUrl, brief), { kind: "demo" });
        await mountDoc(name);
        await emitEvent("wicked.doc.created", { document_id: name, kind: "demo", url: demoUrl, brief }, { producer: PRODUCERS.SERVICE });
        return res.json({ name, head: 0, kind: "demo", learning: true });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // "From my content" (ADR-0010): seed a placeholder v0, emit wicked.doc.created(kind:source).
    // The agent indexes the source(s)/brief and emits wicked.draft.completed with the first draft.
    if (fromSource && sourcePaths.length === 0 && !brief) return res.status(400).json({ error: "add at least one source path or a brief" });
    const html = fromSource
      ? (String(req.body?.html ?? "") || generationPlaceholder(name, sourcePaths, brief))
      : String(req.body?.html ?? "");
    if (!fromSource && !html.trim()) return res.status(400).json({ error: "html required" });

    try {
      const dir = docDir(name);
      initWorkspace(dir, html);
      await mountDoc(name);
      // Seed the original ask as the first conversation entry — the durable "intent" the Intent
      // review (semantic-reviewer) checks the current version against. Best-effort.
      if (brief) appendConversation(dir, { role: "user", text: brief });
      const docKind = fromSource ? "source" : (kind || "html");
      await emitEvent("wicked.doc.created",
        { document_id: name, kind: docKind, ...(fromSource ? { source_paths: sourcePaths, brief } : {}), ...(style ? { style } : {}) },
        { producer: PRODUCERS.SERVICE });
      res.json({ name, head: 0, ...(fromSource ? { generating: true } : {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Mount docs already on disk so their routes are live from the first request.
  async function bootstrap() {
    for (const entry of (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])) {
      if (entry.isDirectory() && isExistingDoc(entry.name)) await mountDoc(entry.name);
    }
  }

  // Static frontend (SPA) at /, mounted LAST so /api/* and /d/* take precedence.
  const staticDir = frontendDir || resolve(HERE, "../../frontend/dist");
  if (existsSync(staticDir)) top.use(express.static(staticDir));

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
