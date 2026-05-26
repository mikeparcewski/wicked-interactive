// server.js — the long-running local service (ADR-0005): serve versions, accept feedback
// as the single writer, watch for _v{n}.md, regenerate, and push updates over SSE (ADR-0006).
// wicked-bus is the event spine (ADR-0004); SSE is the user-facing "ready" signal.

import express from "express";
import chokidar from "chokidar";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { busEmit, EVENTS } from "./bus.js";
import { writeFeedback, processFeedbackFile, forkVersion, loadManifest, readVersionHtml } from "./workspace.js";
import { applyStructuralResponse, REQUESTS_DIR } from "./structural.js";
import { exportHtml, exportPdf } from "./export.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.dir         document workspace directory (already initialised)
 * @param {string} [opts.documentId]
 * @param {Function} [opts.llm]     structural-change LLM (increment 4)
 * @param {boolean} [opts.watch]    enable chokidar processing (default true)
 */
export function createServer({ dir, documentId = "doc", watch = true, frontendDir } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const sseClients = new Set();

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(frame);
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
  app.post("/api/export", (req, res) => {
    const version = Number(req.body?.version);
    const format = String(req.body?.format || "html").toLowerCase();
    if (!Number.isInteger(version)) return res.status(400).json({ error: "version (number) required" });
    if (format !== "html" && format !== "pdf") return res.status(400).json({ error: "format must be html or pdf" });
    try {
      const result = format === "pdf" ? exportPdf(dir, version) : exportHtml(dir, version);
      busEmit(EVENTS.EXPORT_REQUESTED, { document_id: documentId, version, format, ts: new Date().toISOString() });
      res.json({ format, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
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

  return { app, start, stop, emit, broadcast, get clients() { return sseClients.size; } };
}
