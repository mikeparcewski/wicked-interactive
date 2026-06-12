#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve --root <docs-dir> [--port N] [--daemon]
//       Multi-document mode (ADR-0015). Hosts every workspace under <docs-dir>; new docs are
//       created from the UI. The control plane is wicked-bus (ADR-0019).
//
//   Ports, identity & the bridge (ADR-0022). The port is DYNAMIC (no --port → first free from
//   4400 up; --port N is a preference that falls forward if taken). Each root records its live
//   bridge in <root>/.wi-serve.json. Reuse is IDENTITY-aware: we hit the recorded port's
//   /api/health and only reuse if it reports THIS root — if something else is there (or nothing),
//   we start fresh on a new port. So distinct roots never collide and a stale lockfile never
//   points you at the wrong instance.
//
//   --daemon self-detaches: it spawns the server in the background (survives the launching
//   shell/agent call — no nohup/disown needed), waits until the bridge answers, prints the URL,
//   and exits 0. Run it again and it reuses the live bridge for the root.

import { readFileSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMultiServer } from "../src/service/server.js";
import {
  readLock, writeLock, removeLock, pidAlive, pickPort, bridgeIdentity, stopDaemon,
} from "../src/service/serve-bridge.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Is a HEALTHY bridge for THIS exact root already up? Returns its base URL, else null.
// Identity-aware: /api/health must report this root. A lockfile pointing at a dead pid / a
// foreign instance is treated as not-ours (and cleaned if the process is gone).
async function liveBridgeFor(root) {
  const lock = readLock(root);
  if (!lock) return null;
  const id = await bridgeIdentity(lock.host, lock.port);
  if (id && resolve(id) === root) return `http://localhost:${lock.port}`;
  if (!id && !pidAlive(lock.pid)) removeLock(root); // stale — clean it
  return null;
}

// Run the actual server inline (foreground or the detached daemon child).
async function runServer(root, requested, restart = false) {
  if (restart) await stopDaemon(root);   // upgrade/restart: stop any existing daemon for this root first
  const reused = await liveBridgeFor(root);
  if (reused) { printBanner("wicked-interactive (multi-doc) — reusing live bridge for", root, reused); process.exit(0); }

  const port = await pickPort(requested);
  const svc = createMultiServer({ root });
  let actualPort;
  try {
    actualPort = await svc.start(port);
  } catch (e) {
    if (e && e.code === "EADDRINUSE") actualPort = await svc.start(await pickPort(null));
    else throw e;
  }
  const base = `http://localhost:${actualPort}`;
  const wrote = writeLock(root, { port: actualPort, host: "127.0.0.1", pid: process.pid, startedAt: new Date().toISOString(), version: pkgVersion() });
  printBanner("wicked-interactive (multi-doc) serving", root, base);
  if (requested && requested !== actualPort) console.log(`  note:   port ${requested} was taken — using ${actualPort} instead`);
  if (!wrote) console.log(`  note:   could not write .wi-serve.json — other sessions won't auto-discover this bridge`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    removeLock(root);
    // Hard cap: SIGTERM/SIGINT must ALWAYS terminate the process, even if svc.stop() hangs
    // on a held-open SSE connection (the bug that left an old daemon wedged on the port).
    setTimeout(() => process.exit(0), 2500).unref?.();
    try { await svc.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => removeLock(root));
}

// Parent of --daemon: reuse a live bridge, else spawn the server DETACHED, wait for it to answer,
// print the URL, and exit — so the bridge outlives this call without nohup/disown.
async function daemonize(root, requested, restart = false) {
  if (restart) await stopDaemon(root);   // upgrade/restart: stop the old daemon, then spawn fresh (no reuse)
  const reused = await liveBridgeFor(root);
  if (reused) { printBanner("wicked-interactive (multi-doc) — reusing live bridge for", root, reused); return 0; }

  const logPath = join(root, ".wi-serve.log");
  let stdio = ["ignore", "ignore", "ignore"];
  try { const fd = openSync(logPath, "a"); stdio = ["ignore", fd, fd]; } catch { /* unwritable root — run silent */ }
  const childArgs = ["serve", "--root", root, ...(requested ? ["--port", String(requested)] : [])];
  const child = spawn(process.execPath, [SELF, ...childArgs], { detached: true, stdio, env: { ...process.env, WI_DAEMON_CHILD: "1" } });
  child.unref();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const base = await liveBridgeFor(root);
    if (base) {
      printBanner("wicked-interactive (multi-doc) serving", root, base);
      console.log(`  daemon: pid ${child.pid} (detached) · logs → ${logPath}`);
      return 0;
    }
    await sleep(250);
  }
  console.error(`wicked-interactive: the background server didn't come up within 12s — see ${logPath}`);
  return 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== "serve" || !args.root) {
    console.error("usage: wicked-interactive serve --root <docs-dir> [--port N] [--daemon] [--restart]");
    process.exit(1);
  }
  const root = resolve(args.root);
  const requested = args.port ? Number(args.port) : null;
  const restart = !!args.restart;   // stop any existing daemon for this root before starting (clean upgrade)

  // --daemon (and we're the parent, not the spawned child) → detach and return.
  if (args.daemon && !process.env.WI_DAEMON_CHILD) {
    process.exit(await daemonize(root, requested, restart));
  }
  await runServer(root, requested, restart);
}

main().catch((e) => { console.error(e); process.exit(1); });
