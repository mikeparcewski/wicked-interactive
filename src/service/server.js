// server.js — the long-running local service (ADR-0005): serve versions, accept feedback
// as the single writer, watch for _v{n}.md, regenerate, and push updates over SSE (ADR-0006).
// wicked-bus is the event spine (ADR-0004); SSE is the user-facing "ready" signal.

import express from "express";
import chokidar from "chokidar";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { busEmit, EVENTS } from "./bus.js";
import { writeFeedback, processFeedbackFile, loadManifest, readVersionHtml } from "./workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.dir         document workspace directory (already initialised)
 * @param {string} [opts.documentId]
 * @param {Function} [opts.llm]     structural-change LLM (increment 4)
 * @param {boolean} [opts.watch]    enable chokidar processing (default true)
 */
export function createServer({ dir, documentId = "doc", llm, watch = true, frontendDir } = {}) {
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
  const FEEDBACK_FILE = /^_v\d+\.md$/; // chokidar v4 dropped globs — watch the dir, filter here
  function startWatching() {
    watcher = chokidar.watch(dir, { ignoreInitial: true, depth: 0 });
    watcher.on("add", async (p) => {
      const mdFile = basename(p);
      if (!FEEDBACK_FILE.test(mdFile)) return;
      try {
        const result = await processFeedbackFile(dir, mdFile, { emit, llm, documentId });
        if (!result.idempotent) {
          broadcast("processed", {
            version: result.version, applied: result.applied,
            rejected: result.rejected, stale: result.stale,
          });
        }
      } catch (e) {
        broadcast("error", { file: mdFile, error: e.message });
      }
    });
    return new Promise((resolve) => watcher.on("ready", resolve));
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
