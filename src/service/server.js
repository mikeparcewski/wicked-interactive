// server.js — the long-running local service (ADR-0005): serve versions, accept feedback
// as the single writer, watch for _v{n}.md, regenerate, and push updates over SSE (ADR-0006).
// wicked-bus is the event spine (ADR-0004); SSE is the user-facing "ready" signal.

import express from "express";
import chokidar from "chokidar";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { busEmit, EVENTS } from "./bus.js";
import { initWorkspace, writeFeedback, processFeedbackFile, forkVersion, loadManifest, readVersionHtml } from "./workspace.js";
import { applyStructuralResponse, REQUESTS_DIR } from "./structural.js";
import { writeGenerationRequest, applyGeneratedDraft, generationPlaceholder, GEN_RESPONSE } from "./generation.js";
import { demoPlaceholder, writeDemoRequest, recordDemo, RECORDINGS_DIR } from "./demo.js";
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

  // --- Demo (ADR-0018): the agent authors demo.spec.mjs (the click-path); this model-free
  // service EXECUTES + RECORDS it with Playwright and lands the storyboard as a version.
  // Deterministic replay — the same spec yields the same recording. Enqueued on the FIFO
  // so a record never races a feedback regeneration on the manifest.
  app.post("/api/demo/record", (req, res) => {
    const headless = req.body?.headless !== false;
    enqueue(async () => {
      broadcast("status", { state: "working", message: "Recording the demo with Playwright…", ts: new Date().toISOString() });
      try {
        const result = await recordDemo(dir, {
          emit, documentId, headless,
          onStep: ({ index, total, label }) => broadcast("status", {
            state: "working", message: `Step ${index}${total ? `/${total}` : ""}: ${label}`, ts: new Date().toISOString(),
          }),
        });
        broadcast("status", { state: "complete", message: `Recorded v${result.version} (${result.steps.length} steps).`, version: result.version, ts: new Date().toISOString() });
      } catch (e) {
        broadcast("error", { file: "demo.spec.mjs", error: e.message });
        broadcast("status", { state: "error", message: `Demo recording failed: ${e.message}`, ts: new Date().toISOString() });
      }
    });
    res.json({ ok: true, recording: true });
  });

  // Stream a recorded demo video. Path-locked to the slug charset (same guard as the
  // export download) so it can't path-traverse out of recordings/.
  app.get("/api/demo/recording/:name", (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).send("invalid name");
    const filePath = join(dir, RECORDINGS_DIR, name);
    if (!existsSync(filePath)) return res.status(404).send("not found");
    const lower = name.toLowerCase();
    const type = lower.endsWith(".webm") ? "video/webm"
      : lower.endsWith(".png") ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
      : "application/octet-stream";
    res.setHeader("Content-Type", type);
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

  // User -> agent message (ADR-0014), and agent -> user when the supervising agent
  // replies through this lane. Default to "user"; honor an explicit role so an agent
  // post lands as "agent" instead of masquerading as the user. Whitelisted to keep
  // the value safe as a CSS class suffix (wi-msg--{role}) on the frontend.
  const MSG_ROLES = new Set(["user", "agent", "assistant"]);
  app.post("/api/message", (req, res) => {
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.status(400).json({ error: "text required" });
    const reqRole = (req.body?.role || "").toString();
    const role = MSG_ROLES.has(reqRole) ? reqRole : "user";
    const entry = { role, text, ts: new Date().toISOString() };
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

  // --- Sources (ADR-0017): reference material the supervising agent indexes into the
  // brain and draws on when generating/updating. No uploads — the service is local, so
  // the agent reads these real absolute paths directly. The browser only picks paths.
  const sourcesFile = () => resolve(dir, REQUESTS_DIR, "sources.json");
  function readSources() {
    try {
      const f = sourcesFile();
      if (!existsSync(f)) return [];
      const parsed = JSON.parse(readFileSync(f, "utf-8"));
      return Array.isArray(parsed?.sources) ? parsed.sources : [];
    } catch { return []; }
  }
  function writeSources(sources) {
    mkdirSync(resolve(dir, REQUESTS_DIR), { recursive: true });
    writeFileSync(sourcesFile(), JSON.stringify({ sources }, null, 2));
  }

  app.get("/api/sources", (_req, res) => res.json({ sources: readSources() }));

  // User attaches one or more local paths. Dedupe by absolute path; new paths start
  // status "pending" until the agent indexes them. Broadcast so the agent's tail sees it.
  app.post("/api/sources", (req, res) => {
    const incoming = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const note = (req.body?.note || "").toString().trim();
    const paths = incoming.map((p) => (p || "").toString().trim()).filter(Boolean).map((p) => resolve(p));
    if (paths.length === 0) return res.status(400).json({ error: "paths required" });
    const sources = readSources();
    const known = new Set(sources.map((s) => s.path));
    const added = [];
    for (const p of paths) {
      if (known.has(p)) continue;
      known.add(p);
      const entry = { path: p, note, status: "pending", added_at: new Date().toISOString(), indexed_at: null };
      sources.push(entry);
      added.push(entry);
    }
    writeSources(sources);
    if (added.length) {
      broadcast("sources", { sources, added });
      logConvo({ role: "event", text: `Sources attached: ${added.map((s) => basename(s.path)).join(", ")}${note ? ` — ${note}` : ""}` });
    }
    res.json({ ok: true, sources, added });
  });

  // Agent marks a source's index status (pending -> indexing -> indexed | error).
  const SOURCE_STATES = new Set(["pending", "indexing", "indexed", "error"]);
  app.post("/api/sources/status", (req, res) => {
    const path = (req.body?.path || "").toString().trim();
    const status = (req.body?.status || "").toString();
    if (!path) return res.status(400).json({ error: "path required" });
    if (!SOURCE_STATES.has(status)) return res.status(400).json({ error: "invalid status" });
    const target = resolve(path);
    const sources = readSources();
    const entry = sources.find((s) => s.path === target);
    if (!entry) return res.status(404).json({ error: "unknown source" });
    entry.status = status;
    if (status === "indexed") entry.indexed_at = new Date().toISOString();
    writeSources(sources);
    broadcast("sources", { sources });
    res.json({ ok: true, sources });
  });

  // Local filesystem browser for the path picker. The page can't read real disk paths
  // from <input type=file>, so the user navigates the local tree here and we hand back
  // absolute paths. Localhost-only; dotfiles hidden; never exposes file contents.
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
          let dir = d.isDirectory();
          if (d.isSymbolicLink()) { try { dir = statSync(join(target, d.name)).isDirectory(); } catch { dir = false; } }
          return { name: d.name, path: join(target, d.name), dir };
        })
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      const parent = dirname(target);
      res.json({ path: target, parent: parent === target ? null : parent, home, entries });
    } catch (e) {
      const code = e.code === "EACCES" ? 403 : e.code === "ENOENT" ? 404 : 500;
      res.status(code).json({ error: e.message });
    }
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
  const GEN_RESPONSE_FILE = new RegExp(`^${GEN_RESPONSE.replace(/\./g, "\\.")}$`); // first-draft reply
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
        } else if (GEN_RESPONSE_FILE.test(name)) {
          const result = await applyGeneratedDraft(dir, name, { emit, documentId });
          broadcast("processed", {
            version: result.version, parent: result.parent, generated: true,
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
  // promptly and downstream watchdogs (bin/wi-watch.mjs has STALL_MS=180s) stay green
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
        out.push({ name, kind: m.kind || "doc", head: m.head, versions: m.versions.length, updated_at: last.created_at || null });
      } catch { /* skip malformed */ }
    }
    return out.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  // Top-level (cross-doc) endpoints
  top.get("/api/preflight", (_req, res) => res.json(preflight()));
  top.get("/api/docs", (_req, res) => res.json(listDocs()));

  top.post("/api/docs", async (req, res) => {
    const raw = req.body?.name;
    const kind = String(req.body?.kind || "").toLowerCase();
    const fromSource = kind === "source";
    const isDemo = kind === "demo";
    const sourcePaths = (Array.isArray(req.body?.source_paths) ? req.body.source_paths : [])
      .map((s) => String(s).trim()).filter(Boolean);
    const brief = String(req.body?.brief ?? "").trim();
    const demoUrl = String(req.body?.url ?? "").trim();
    const name = DOC_NAME.test(raw) ? raw : slugify(raw);
    if (!name || !DOC_NAME.test(name)) return res.status(400).json({ error: "valid name required (lowercase letters, digits, hyphens; up to 64 chars)" });
    if (isExistingDoc(name)) return res.status(409).json({ error: "doc already exists", name });

    // Demo (ADR-0018): point at a live URL; the service seeds a placeholder storyboard v0 and
    // hands a demo request to the supervising agent, which explores the app, authors
    // demo.spec.mjs, then calls POST /d/<doc>/api/demo/record to execute + record it.
    if (isDemo) {
      let u;
      try { u = new URL(demoUrl); } catch { return res.status(400).json({ error: "a valid http(s) url is required for a demo" }); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return res.status(400).json({ error: "demo url must be http or https" });
      try {
        const dir = docDir(name);
        initWorkspace(dir, demoPlaceholder(name, demoUrl, brief), { kind: "demo" });
        const { svc } = await mountDoc(name);
        writeDemoRequest(dir, { url: demoUrl, brief, documentId: name });
        svc.broadcast("demo", { document_id: name, url: demoUrl, brief, base_html: "_v0.html", ts: new Date().toISOString() });
        return res.json({ name, head: 0, kind: "demo", learning: true });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // "From my content" (ADR-0010): the service is model-free, so it can't read files or
    // generate. It seeds a placeholder v0, then hands a generation request to the supervising
    // agent, which indexes the source(s) and lands the real first draft as a follow-on version.
    // kind:source needs *something* to build from — either source files or a written brief.
    // (Brief-only is a first-class path: the agent generates from the brief alone, no files.)
    if (fromSource && sourcePaths.length === 0 && !brief) return res.status(400).json({ error: "add at least one source path or a brief" });
    const html = fromSource
      ? (String(req.body?.html ?? "") || generationPlaceholder(name, sourcePaths, brief))
      : String(req.body?.html ?? "");
    if (!fromSource && !html.trim()) return res.status(400).json({ error: "html required" });

    try {
      const dir = docDir(name);
      initWorkspace(dir, html);                  // seeds _v0.html + versions.json
      const { svc } = await mountDoc(name);
      if (fromSource) {
        writeGenerationRequest(dir, { sourcePaths, brief, documentId: name });
        // Fan a generation event onto /api/events/all so the assist loop picks it up.
        svc.broadcast("generation", { document_id: name, source_paths: sourcePaths, brief, base_html: "_v0.html", ts: new Date().toISOString() });
      }
      res.json({ name, head: 0, ...(fromSource ? { generating: true } : {}) });
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

