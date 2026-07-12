#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve [--root <docs-dir>] [--port N] [--daemon] [--restart]
//       Multi-document mode (ADR-0015). Hosts every workspace under <docs-dir>; new docs are
//       created from the UI. The control plane is wicked-bus (ADR-0019).
//
//   ONE SHARED INSTANCE by default (ADR-0022 amended). With no --root, every session uses the
//   canonical root ~/wicked-interactive/docs — so `serve --daemon` from any session REUSES the one
//   running bridge instead of spawning another on a different port (the "why is it on 5 ports"
//   confusion). Pass --root only when you deliberately want a SEPARATE, isolated instance.
//
//   Ports, identity & the bridge (ADR-0022). The port is DYNAMIC (no --port → first free from
//   4400 up; --port N is a preference that falls forward if taken). Each root records its live
//   bridge in <root>/.wi-serve.json. Reuse is IDENTITY-aware: we hit the recorded port's
//   /api/health (retried while the recorded pid is alive, so a busy daemon is reused, not
//   duplicated) and only reuse if it reports THIS root. Distinct roots never collide.
//
//   --daemon self-detaches: spawns the server in the background (survives the launching shell/agent
//   call — no nohup/disown), waits until the bridge answers, prints the URL, exits 0. `--restart`
//   stops an existing daemon for the root first (clean upgrade); plain re-run reuses the live one.

import { readFileSync, openSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createMultiServer } from "../src/service/server.js";
import {
  readLock, writeLock, removeLock, pidAlive, pickPort, bridgeIdentity, stopDaemon,
} from "../src/service/serve-bridge.mjs";
import { registerInstance, deregisterInstance } from "../src/service/instances.mjs";

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
  // If the recorded daemon process is ALIVE it may just be slow to answer (busy materializing,
  // GC, a cold first hit) — retry the identity check before concluding it's unusable. This is the
  // anti-"spawn a duplicate on a fallback port" guard: prefer REUSING the one shared instance.
  const attempts = pidAlive(lock.pid) ? 3 : 1;
  for (let i = 0; i < attempts; i++) {
    const id = await bridgeIdentity(lock.host, lock.port, { timeoutMs: 1500 });
    if (id && resolve(id) === root) return `http://localhost:${lock.port}`;
    if (i < attempts - 1) await sleep(300);
  }
  if (!pidAlive(lock.pid)) removeLock(root); // truly gone — clean the stale lock
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
  registerInstance(root, { port: actualPort, host: "127.0.0.1", pid: process.pid, version: pkgVersion() }); // cross-instance registry (the UI project switcher)
  printBanner("wicked-interactive (multi-doc) serving", root, base);
  if (requested && requested !== actualPort) console.log(`  note:   port ${requested} was taken — using ${actualPort} instead`);
  if (!wrote) console.log(`  note:   could not write .wi-serve.json — other sessions won't auto-discover this bridge`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    removeLock(root); deregisterInstance(root);
    // Hard cap: SIGTERM/SIGINT must ALWAYS terminate the process, even if svc.stop() hangs
    // on a held-open SSE connection (the bug that left an old daemon wedged on the port).
    setTimeout(() => process.exit(0), 2500).unref?.();
    try { await svc.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => { removeLock(root); deregisterInstance(root); });
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
  const cmd = args._[0];

  // Artifact subcommands — dynamically imported so serve-specific modules are not loaded.
  if (cmd === "create") {
    const { runCreate } = await import("../src/artifact/create.js");
    process.exit((await runCreate(args)) ?? 0);
  }
  if (cmd === "publish") {
    const { runPublish } = await import("../src/artifact/publish.js");
    process.exit((await runPublish(args)) ?? 0);
  }
  if (cmd === "validate") {
    const { runValidate } = await import("../src/artifact/validate.js");
    process.exit((await runValidate(args)) ?? 0);
  }

  if (cmd !== "serve") {
    console.error("usage: wicked-interactive <create|publish|validate|serve> [options]");
    console.error("  create   --from-crew <id> | --from-garden <id> | --from-file <path>  [--output <path>]");
    console.error("  publish  <artifact-path> [--api-key <key>]");
    console.error("  validate <artifact-path>");
    console.error("  serve    [--root <docs-dir>] [--port N] [--daemon] [--restart]");
    process.exit(1);
  }
  // ONE shared instance by default (ADR-0022 amended): every session converges on the canonical
  // root ~/wicked-interactive/docs, so `serve --daemon` from any session REUSES the single running
  // bridge instead of spawning another on a new port. Pass --root only for an isolated instance.
  const root = args.root ? resolve(args.root) : resolve(homedir(), "wicked-interactive", "docs");
  try { mkdirSync(root, { recursive: true }); } catch { /* unwritable — serve surfaces it */ }
  const requested = args.port ? Number(args.port) : null;
  const restart = !!args.restart;   // stop any existing daemon for this root before starting (clean upgrade)

  // --daemon (and we're the parent, not the spawned child) → detach and return.
  if (args.daemon && !process.env.WI_DAEMON_CHILD) {
    process.exit(await daemonize(root, requested, restart));
  }
  await runServer(root, requested, restart);
}

main().catch((e) => { console.error(e); process.exit(1); });
