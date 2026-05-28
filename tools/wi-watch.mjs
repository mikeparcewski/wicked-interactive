#!/usr/bin/env node
// wi-watch.mjs — operator-facing event tail for the multi-doc service.
//
// Connects to GET /api/events/all (added in ADR-0015 follow-up) and prints one event
// per stdout line: `HH:MM:SS doc event {json}`. Each line is one event so it composes
// with the Monitor tool's line-as-event model.
//
// Resilience (after the 2026-05-28 silent-watcher incident):
//   - Reconnects on every terminal signal the socket can emit: end, error, close,
//     AND socket-level error/close. The earlier version only handled end+error and
//     went silent when an abrupt service kill emitted `close` first.
//   - Stream watchdog: if no bytes (not even a heartbeat) arrive for STALL_MS, treat
//     the connection as dead and reconnect. Catches the case where the socket is
//     half-open (kernel never delivers an EOF).
//   - 30s server-side heartbeat ping keeps proxies + the watchdog happy.
//   - Reconnect is idempotent — only one reconnect timer fires per disconnect.
//   - Backs off briefly between retries (250ms / 1s) so a crash-looping service doesn't
//     melt the watcher.
//   - Long-lived: never exits on its own. Stop it with SIGINT/SIGTERM or Monitor TaskStop.

import http from "node:http";
import { parseArgs } from "node:util";

const { values: argv } = parseArgs({
  options: {
    base:   { type: "string", default: process.env.WI_BASE || "http://localhost:4400" },
    quiet:  { type: "boolean", default: false },  // suppress connect/reconnect lines
  },
});

const url = new URL("/api/events/all", argv.base);
const STALL_MS = 60_000;   // no traffic for this long → assume dead, reconnect

function ts() { return new Date().toISOString().slice(11, 19); }
function note(msg) { if (!argv.quiet) console.log(`${ts()} watcher ${msg}`); }

function connect() {
  let scheduled = false;
  let stallTimer = null;
  function scheduleReconnect(reason, delayMs) {
    if (scheduled) return;            // first signal wins; ignore the others
    scheduled = true;
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    note(`${reason} — reconnecting in ${delayMs}ms`);
    setTimeout(connect, delayMs);
  }
  function bumpWatchdog() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => scheduleReconnect(`no traffic for ${STALL_MS}ms`, 250), STALL_MS);
  }

  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      note(`http ${res.statusCode}`);
      res.resume();
      scheduleReconnect("non-200", 1000);
      return;
    }
    note(`connected ${url.href}`);
    bumpWatchdog();
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      bumpWatchdog();
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = "?", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) ev = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (ev === "ready") continue;
        let parsed = data;
        try { parsed = JSON.stringify(JSON.parse(data)); } catch { /* keep raw */ }
        let doc = "?";
        try { const o = JSON.parse(data); if (o.doc) doc = o.doc; } catch {}
        console.log(`${ts()} ${doc} ${ev} ${parsed.slice(0, 280)}`);
      }
    });
    res.on("end",   ()  => scheduleReconnect("stream end", 250));
    res.on("close", ()  => scheduleReconnect("stream close", 250));
    res.on("error", (e) => scheduleReconnect(`stream error: ${e.message}`, 1000));
    // Socket-level events catch abrupt TCP resets that don't surface as response events.
    if (res.socket) {
      res.socket.on("error", (e) => scheduleReconnect(`socket error: ${e.message}`, 1000));
      res.socket.on("close",  ()  => scheduleReconnect("socket close", 250));
    }
  });
  req.setTimeout(0);
  req.on("error", (e) => scheduleReconnect(`http error: ${e.message}`, 1000));
}

process.on("SIGINT",  () => { note("SIGINT — bye"); process.exit(0); });
process.on("SIGTERM", () => { note("SIGTERM — bye"); process.exit(0); });

note(`starting; tailing ${url.href}`);
connect();
