#!/usr/bin/env node
// wi-watch.mjs — operator-facing event tail for the multi-doc service.
//
// Connects to GET /api/events/all (added in ADR-0015 follow-up) and prints one event
// per stdout line: `HH:MM:SS doc event {json}`. Each line is one event so it composes
// with the Monitor tool's line-as-event model.
//
// Resilience:
//   - Reconnects automatically when the SSE stream drops (service restart, network blip).
//   - Backs off briefly between retries (250ms, capped) so a crash-looping service doesn't
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

function ts() { return new Date().toISOString().slice(11, 19); }
function note(msg) { if (!argv.quiet) console.log(`${ts()} watcher ${msg}`); }

function connect() {
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      note(`http ${res.statusCode} — retrying in 1s`);
      res.resume();
      setTimeout(connect, 1000);
      return;
    }
    note(`connected ${url.href}`);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
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
        // Pull doc name to the front for grep-ability.
        let doc = "?";
        try { const o = JSON.parse(data); if (o.doc) doc = o.doc; } catch {}
        console.log(`${ts()} ${doc} ${ev} ${parsed.slice(0, 280)}`);
      }
    });
    res.on("end", () => { note("stream closed — reconnecting in 250ms"); setTimeout(connect, 250); });
    res.on("error", (e) => { note(`stream error: ${e.message} — reconnecting in 1s`); setTimeout(connect, 1000); });
  });
  req.setTimeout(0);
  req.on("error", (e) => { note(`http error: ${e.message} — retrying in 1s`); setTimeout(connect, 1000); });
}

process.on("SIGINT",  () => { note("SIGINT — bye"); process.exit(0); });
process.on("SIGTERM", () => { note("SIGTERM — bye"); process.exit(0); });

note(`starting; tailing ${url.href}`);
connect();
