// serve-bridge.mjs — dynamic port + per-root bridge discovery (ADR-0022).
//
// One bridge per docs-root. The live bridge records itself in <root>/.wi-serve.json so any
// session can answer "is there a bridge for this root, and on what port?" without remembering
// anything. Pure, side-effect-light helpers live here so they can be unit-tested; the CLI
// (bin/wicked-interactive.js) wires them to process lifecycle.

import { createServer } from "node:net";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const LOCK_NAME = ".wi-serve.json";
export const PORT_BASE = 4400;          // friendly starting point for the free-port scan
export const PORT_SPAN = 60;            // scan 4400..4459 before letting the OS assign one
export const HEALTH_PATH = "/api/docs"; // any 200 from this is "our bridge is alive"

export const lockPath = (root) => join(root, LOCK_NAME);

export function readLock(root) {
  try { return JSON.parse(readFileSync(lockPath(root), "utf8")); }
  catch { return null; } // absent or unreadable — treat as "no bridge"
}

export function writeLock(root, info) {
  try { writeFileSync(lockPath(root), JSON.stringify(info, null, 2)); return true; }
  catch { return false; } // unwritable root — serve still runs, reuse just won't be available
}

export function removeLock(root) {
  try { unlinkSync(lockPath(root)); } catch { /* already gone */ }
}

// A pid we can signal-0 without ESRCH is alive (EPERM still means "exists"). pid<=0 → unknown.
export function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Stop the daemon recorded in <root>'s lockfile so a restart/upgrade is clean (ADR-0022).
// SIGTERM first (the daemon's handler closes + exits, with its own hard cap), poll until the pid
// is gone, then escalate to SIGKILL if it's wedged (e.g. an old build whose graceful stop hangs
// on open SSE). Always clears the lockfile. `kill`/`alive`/`sleep` are injectable for tests.
// Returns { stopped, pid, forced } — stopped:false{reason:"not-running"} when nothing was up.
export async function stopDaemon(root, { kill = process.kill, alive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), graceMs = 3000, stepMs = 150 } = {}) {
  const lock = readLock(root);
  const pid = lock && lock.pid;
  if (!pid || !alive(pid)) { removeLock(root); return { stopped: false, reason: "not-running" }; }
  try { kill(pid, "SIGTERM"); } catch { /* already gone between read and signal */ }
  for (let waited = 0; waited < graceMs; waited += stepMs) {
    if (!alive(pid)) { removeLock(root); return { stopped: true, pid, forced: false }; }
    await sleep(stepMs);
  }
  try { kill(pid, "SIGKILL"); } catch { /* gone */ }   // wedged — force it
  await sleep(stepMs);
  removeLock(root);
  return { stopped: true, pid, forced: true };
}

// True iff `port` can be bound right now (probe binds + immediately releases it).
export function isPortFree(port) {
  return new Promise((res) => {
    const probe = createServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, "0.0.0.0");
  });
}

// Resolve a bindable port: try `preferred`, then scan upward, then let the OS assign one (0).
export async function pickPort(preferred) {
  const start = Number.isInteger(preferred) && preferred > 0 ? preferred : PORT_BASE;
  for (let p = start; p < start + PORT_SPAN; p++) {
    if (await isPortFree(p)) return p;
  }
  return 0; // exhausted the friendly range — OS assigns any free port
}

// Is something answering as a wicked-interactive bridge on host:port right now?
export async function bridgeHealthy(host, port, { timeoutMs = 800, path = HEALTH_PATH } = {}) {
  if (!port) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host || "127.0.0.1"}:${port}${path}`, { signal: ctrl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// WHICH instance is on host:port? Hits /api/health and returns the docs root it serves (or null
// if nothing answers / it isn't a wicked-interactive bridge). Identity-aware so a launcher can
// tell "my bridge for this root" from "someone else's instance on the same port" (ADR-0022).
export async function bridgeIdentity(host, port, { timeoutMs = 800 } = {}) {
  if (!port) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host || "127.0.0.1"}:${port}/api/health`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const body = await r.json();
    return typeof body?.root === "string" ? body.root : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
