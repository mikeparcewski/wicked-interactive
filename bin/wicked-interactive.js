#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve --root <docs-dir> [--port N]
//       Multi-document mode (ADR-0015). Hosts every workspace under <docs-dir>; new docs are
//       created from the UI. The control plane is wicked-bus (ADR-0019): the agent watches the
//       loop with `wicked-bus subscribe --filter '*@wicked-interactive'`, not a bespoke tail.
//
//   Ports & the bridge (ADR-0022). Multiple sessions serve different roots at once, so the port
//   is DYNAMIC: with no --port we take the first free port from 4400 up; --port N pins a
//   preference but still falls forward if it's taken. The running bridge for a root records
//   itself in <root>/.wi-serve.json {port,pid,host,...}. Starting a second serve on a root that
//   already has a HEALTHY bridge reuses it (prints the URL, exits 0) instead of conflicting; a
//   lockfile whose process is gone is treated as stale and a fresh bridge is started. The agent
//   discovers "where is the bridge for this root" by reading that lockfile — no port to remember.

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMultiServer } from "../src/service/server.js";
import {
  LOCK_NAME, readLock, writeLock, removeLock, pidAlive, pickPort, bridgeHealthy,
} from "../src/service/serve-bridge.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function pkgVersion() {
  try { return JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version || null; }
  catch { return null; }
}

function printBanner(prefix, root, base) {
  console.log(`${prefix} ${root} on ${base}`);
  console.log(`  docs:   ${base}/api/docs`);
  console.log(`  open:   ${base}/?doc=<name>`);
  console.log(`  loop:   wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' --cursor-init latest`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== "serve" || !args.root) {
    console.error("usage: wicked-interactive serve --root <docs-dir> [--port N]");
    process.exit(1);
  }

  const root = resolve(args.root);
  const requested = args.port ? Number(args.port) : null;

  // ── Reuse the bridge if this root already has a healthy one (ADR-0022) ──────────────
  const existing = readLock(root);
  if (existing && await bridgeHealthy(existing.host, existing.port)) {
    const base = `http://localhost:${existing.port}`;
    printBanner("wicked-interactive (multi-doc) — reusing live bridge for", root, base);
    process.exit(0);
  }
  if (existing && !(await bridgeHealthy(existing.host, existing.port)) && !pidAlive(existing.pid)) {
    removeLock(root); // stale lockfile from a process that's gone — clean it and start fresh
  }

  const port = await pickPort(requested);
  const svc = createMultiServer({ root });
  let actualPort;
  try {
    actualPort = await svc.start(port);
  } catch (e) {
    if (e && e.code === "EADDRINUSE" && requested) {
      // The pinned port raced us; fall forward to any free port rather than dying.
      actualPort = await svc.start(await pickPort(null));
    } else { throw e; }
  }

  const host = "127.0.0.1";
  const base = `http://localhost:${actualPort}`;
  const wrote = writeLock(root, {
    port: actualPort, host, pid: process.pid,
    startedAt: new Date().toISOString(), version: pkgVersion(),
  });
  printBanner("wicked-interactive (multi-doc) serving", root, base);
  if (requested && requested !== actualPort) {
    console.log(`  note:   port ${requested} was taken — using ${actualPort} instead`);
  }
  if (!wrote) console.log(`  note:   could not write ${LOCK_NAME} in the root — other sessions won't auto-discover this bridge`);

  // Drop the lockfile on the way out so a future serve doesn't think we're still up.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    removeLock(root);
    try { await svc.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => removeLock(root)); // sync safety net for hard exits
}

main().catch((e) => { console.error(e); process.exit(1); });
