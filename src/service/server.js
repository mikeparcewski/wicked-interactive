// server.js — the long-running local service (ADR-0005): serve versions, accept feedback
// as the single writer, watch for _v{n}.md, regenerate, and push updates over SSE (ADR-0006).
// wicked-bus is the event spine (ADR-0004); SSE is the user-facing "ready" signal.

import express from "express";
import chokidar from "chokidar";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { busEmit, EVENTS } from "./bus.js";
import { initWorkspace, writeFeedback, processFeedbackFile, forkVersion, loadManifest, readVersionHtml } from "./workspace.js";
import { applyStructuralResponse, REQUESTS_DIR } from "./structural.js";
import { exportHtml, exportPdf } from "./export.js";
import { preflight } from "./preflight.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.dir         document workspace directory (already initialised)
 * @param {string} [opts.documentId]
 * @param {Function} [opts.llm]     structural-change LLM (increment 4)
 * @param {boolean} [opts.watch]    enable chokidar processing (default true)
 */
export function createServer({ dir, documentId = "doc", watch = true, frontendDir, tap } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const sseClients = new Set();

  // `tap` is the cross-server hook used by createMultiServer to fan all per-doc events
  // into a single top-level /api/events/all stream. It's a fire-and-forget callback —
  // exceptions are swallowed so a dead tap can't break the doc's own SSE clients.
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
    if (tap) { try { tap(event, data); } catch { /* never let the tap break broadcasts */ } }
  }

  // Pipeline emitter: fan out to the bus and (for html updates) to connected browsers.
  function emit(key, payload) {
    busEmit(EVENTS[key], payload);
    if (key === "HTML_UPDATED") broadcast("html-updated", payload);
  }

  // FIFO serialization (ADR-0007): process watcher events one at a time so concurrent
  // regenerations never race on the manifest.
  let queue = Promise.resolve();
  const enqueue = (task) => { queue = queue.then(task).catch(() => {}); return queue; };

  // Plugin install-gate (ADR-0016): report which sibling plugins are present so the
  // editor can block on missing ones. Cheap (existsSync only); safe to call on every load.
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

  // Single-writer feedback intake (ADR-0002). chokidar processes the written file.
  app.post("/api/feedback", (req, res) => {
    const { items, author } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items[] required" });
    }
    try {
      const { version, file } = writeFeedback(dir, { items, author });
      busEmit(EVENTS.FEEDBACK_RECEIVED, {
        document_id: documentId, version_target: version, feedback_file: file,
        item_count: items.length, ts: new Date().toISOString(),
      });
      res.json({ version, file });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Fork / "start again from here" (ADR-0008, AC-21): non-destructive.
  app.post("/api/fork", (req, res) => {
    const from = Number(req.body?.from);
    if (!Number.isInteger(from)) return res.status(400).json({ error: "from (version number) required" });
    try {
      const { version, parent } = forkVersion(dir, from);
      emit("HTML_UPDATED", {
        document_id: documentId, version, html_file: `_v${version}.html`, prev_version: parent, ts: new Date().toISOString(),
      });
      res.json({ version, parent });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Export to self-contained HTML or PDF (ADR-0009), triggered from the browser.
  // POST creates the file under <workspace>/exports/; response includes a `download`
  // URL the frontend can hit to actually pull the bytes (the server-side `path` alone
  // never reached the user's machine — see the 2026-05-28 "PDF/HTML might generate,
  // but not downloading" report).
  app.post("/api/export", (req, res) => {
    const version = Number(req.body?.version);
    const format = String(req.body?.format || "html").toLowerCase();
    if (!Number.isInteger(version)) return res.status(400).json({ error: "version (number) required" });
    if (format !== "html" && format !== "pdf") return res.status(400).json({ error: "format must be html or pdf" });
    try {
      const result = format === "pdf" ? exportPdf(dir, version) : exportHtml(dir, version);
      const file = basename(result.path);
      const download = `${req.baseUrl || ""}/api/export/file/${encodeURIComponent(file)}`;
      busEmit(EVENTS.EXPORT_REQUESTED, { document_id: documentId, version, format, ts: new Date().toISOString() });
      res.json({ format, ...result, file, download });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Download the actual exported file. Content-Disposition: attachment forces a save
  // dialog regardless of the file's MIME type. Filenames are restricted to the slug
  // characters export.js uses, so this can't path-traverse.
  app.get("/api/export/file/:name", (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).send("invalid name");
    const filePath = join(dir, "exports", name);
    if (!existsSync(filePath)) return res.status(404).send("not found");
    const isPdf = name.toLowerCase().endsWith(".pdf");
    res.setHeader("Content-Type", isPdf ? "application/pdf" : "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.sendFile(filePath);
  });

  // Conversation log (ADR-0014): append-only transcript persisted across reloads.
  const convoFile = () => resolve(dir, "conversation.jsonl");
  function logConvo(entry) {
    try { appendFileSync(convoFile(), JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() }) + "\n"); }
    catch { /* best-effort */ }
  }

  // Agent status channel (ADR-0012): the supervising agent posts progress / questions.
  app.post("/api/status", (req, res) => {
    const { state, message, version, requestId, question, options } = req.body || {};
    broadcast("status", { state, message, version, requestId, question, options, ts: new Date().toISOString() });
    if (message || question) logConvo({ role: "agent", text: question || message, state });
    res.json({ ok: true });
  });

  // User -> agent message (ADR-0014). The agent's SSE listener receives the broadcast.
  app.post("/api/message", (req, res) => {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.status(400).json({ error: "text required" });
    const entry = { role: "user", text, ts: new Date().toISOString() };
    logConvo(entry);
    broadcast("message", entry);
    res.json({ ok: true });
  });

  app.get("/api/conversation", (_req, res) => {
    try {
      const lines = existsSync(convoFile()) ? readFileSync(convoFile(), "utf-8").trim() : "";
      res.json(lines ? lines.split("\n").map((l) => JSON.parse(l)) : []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // User's answer to an agent question -> written as a file the agent reads, + broadcast.
  app.post("/api/answer", (req, res) => {
    const { requestId, answer } = req.body || {};
    if (!requestId) return res.status(400).json({ error: "requestId required" });
    mkdirSync(resolve(dir, REQUESTS_DIR), { recursive: true });
    const file = `${requestId}.answer.json`;
    writeFileSync(resolve(dir, REQUESTS_DIR, file), JSON.stringify({ requestId, answer, ts: new Date().toISOString() }, null, 2));
    broadcast("answer", { requestId, answer });
    res.json({ ok: true, file });
  });

  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    res.write("event: ready\ndata: {}\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  // Serve the built React app at / (production). In dev, Vite serves it and proxies the
  // API/doc/events back here. Mounted after the API routes so they take precedence.
  const staticDir = frontendDir || resolve(HERE, "../../frontend/dist");
  if (existsSync(staticDir)) app.use(express.static(staticDir));

  let watcher;
  const root = resolve(dir);
  const FEEDBACK_FILE = /^_v\d+\.md$/;             // feedback batch, in the workspace root
  const RESPONSE_FILE = /^_v\d+\.response\.json$/; // agent's structural reply, in requests/
  function startWatching() {
    mkdirSync(resolve(dir, REQUESTS_DIR), { recursive: true }); // so depth:1 sees responses
    // chokidar v4 dropped globs — watch the tree (depth 1) and route by path here.
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 1 });
    watcher.on("add", (p) => enqueue(async () => {
      const name = basename(p);
      try {
        if (FEEDBACK_FILE.test(name) && resolve(dirname(p)) === root) {
          const result = await processFeedbackFile(dir, name, { emit, documentId });
          if (!result.idempotent) {
            broadcast("processed", {
              version: result.version, applied: result.applied,
              rejected: result.rejected, stale: result.stale,
              awaiting_structural: result.awaiting_structural,
            });
          }
        } else if (RESPONSE_FILE.test(name)) {
          const result = await applyStructuralResponse(dir, name, { emit, documentId });
          broadcast("processed", {
            version: result.version, parent: result.parent,
            applied: result.applied, rejected: result.rejected, structural: true,
          });
        }
      } catch (e) {
        broadcast("error", { file: name, error: e.message });
      }
    }));
    return new Promise((res) => watcher.on("ready", res));
  }

  let server;
  async function start(port = 0) {
    if (watch) await startWatching();
    return new Promise((resolve) => {
      server = app.listen(port, () => resolve(server.address().port));
    });
  }
  async function stop() {
    if (watcher) await watcher.close();
    if (server) await new Promise((r) => server.close(r));
    for (const res of sseClients) res.end();
    sseClients.clear();
  }

  return { app, start, stop, startWatching, emit, broadcast, get clients() { return sseClients.size; } };
}

// ---------------------------------------------------------------------------
// Multi-document mode (ADR-0015): one express server hosting many workspaces
// under a docs root. Each doc gets its own createServer sub-app mounted at
// /d/:doc/. Top-level adds GET /api/docs + POST /api/docs.
// ---------------------------------------------------------------------------

const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/; // slug-safe, no path separators

function slugify(name) {
  return String(name || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

/** Create a multi-doc server. `root` is the parent dir holding one subdir per doc. */
export function createMultiServer({ root, frontendDir, llm } = {}) {
  if (!root) throw new Error("createMultiServer: root is required");
  mkdirSync(root, { recursive: true });
  const top = express();
  top.use(express.json({ limit: "5mb" }));

  const docs = new Map();          // name -> { svc, dir }
  let topServer;

  // Cross-doc event stream (operator-facing). Per-doc servers call `tap()` on every
  // broadcast; we fan them out to anyone subscribed to /api/events/all, prepending the
  // doc name so the receiver can route. Cheap (in-memory; no extra HTTP hops).
  const topClients = new Set();
  function topBroadcast(doc, event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify({ doc, ...data })}\n\n`;
    for (const res of topClients) res.write(frame);
  }
  // SSE heartbeat — a comment frame every 15s so half-open sockets surface as errors
  // promptly and downstream watchdogs (tools/wi-watch.mjs has STALL_MS=180s) stay green
  // even if several pings are lost. SSE comments start with `:` and are ignored by EventSource.
  //
  // We also `setNoDelay(true)` on the socket so the kernel doesn't buffer the (small)
  // comment payloads via Nagle — pre-fix, the 24-byte heartbeats sat in the socket
  // buffer and the watcher's 60s watchdog tripped every 7-16 minutes.
  top.get("/api/events/all", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    res.write("event: ready\ndata: {\"watching\":\"*\"}\n\n");
    topClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* socket dead — close handler will clear */ } }, 15_000);
    const cleanup = () => { clearInterval(heartbeat); topClients.delete(res); };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  function docDir(name) { return resolve(root, name); }
  function isExistingDoc(name) {
    return DOC_NAME.test(name) && existsSync(join(docDir(name), "versions.json"));
  }

  async function mountDoc(name) {
    if (docs.has(name)) return docs.get(name);
    if (!isExistingDoc(name)) throw new Error(`unknown or invalid doc: ${name}`);
    const dir = docDir(name);
    const svc = createServer({
      dir, documentId: name, llm, watch: false, frontendDir: null,
      tap: (event, data) => topBroadcast(name, event, data),  // fan into /api/events/all
    });
    await svc.startWatching();
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
        out.push({ name, head: m.head, versions: m.versions.length, updated_at: last.created_at || null });
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  // Top-level (cross-doc) endpoints
  top.get("/api/preflight", (_req, res) => res.json(preflight()));
  top.get("/api/docs", (_req, res) => res.json(listDocs()));

  top.post("/api/docs", async (req, res) => {
    const raw = req.body?.name;
    const html = String(req.body?.html ?? "");
    const name = DOC_NAME.test(raw) ? raw : slugify(raw);
    if (!name || !DOC_NAME.test(name)) return res.status(400).json({ error: "valid name required (lowercase letters, digits, hyphens; up to 64 chars)" });
    if (!html.trim()) return res.status(400).json({ error: "html required" });
    if (isExistingDoc(name)) return res.status(409).json({ error: "doc already exists", name });
    try {
      const dir = docDir(name);
      initWorkspace(dir, html);                  // seeds _v0.html + versions.json
      await mountDoc(name);
      res.json({ name, head: 0 });
    } catch (e) {
      // initWorkspace / mountDoc can throw on malformed HTML or a filesystem error.
      // Return a 400 instead of leaking a 500 + stack to the browser.
      res.status(400).json({ error: e.message });
    }
  });

  // Mount any docs already on disk so their routes are live from the first request.
  // (Synchronous-enough — chokidar 'ready' resolves quickly per dir.)
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
    return new Promise((resolve) => { topServer = top.listen(port, () => resolve(topServer.address().port)); });
  }
  async function stop() {
    for (const { svc } of docs.values()) { try { await svc.stop(); } catch {} }
    if (topServer) await new Promise((r) => topServer.close(r));
  }

  return { app: top, start, stop, mountDoc, listDocs, get docCount() { return docs.size; } };
}

