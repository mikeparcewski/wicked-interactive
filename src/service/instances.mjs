// instances.mjs — a tiny cross-instance registry so the UI can list/switch between the running
// wicked-interactive instances (ADR-0025 follow-up). Each `serve` registers its root + bridge in
// ~/.wicked-interactive/instances.json on start and removes itself on clean shutdown. The switcher
// reads it (filtered to live pids) to offer "open another project" and to show the current root.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

export const REGISTRY = join(homedir(), ".wicked-interactive", "instances.json");

function readAll(file) {
  try { const o = JSON.parse(readFileSync(file, "utf8")); return o && typeof o === "object" ? o : {}; }
  catch { return {}; } // absent / unreadable / corrupt → empty registry
}
function writeAll(map, file) {
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(map, null, 2)); return true; }
  catch { return false; } // best-effort — the switcher just won't see this instance
}

/** Record (or refresh) this instance keyed by its root. `info` carries { port, host, pid, version }. */
export function registerInstance(root, info = {}, file = REGISTRY) {
  const map = readAll(file);
  map[root] = { root, name: basename(root) || root, ...info, updatedAt: new Date().toISOString() };
  return writeAll(map, file);
}

/** Remove this instance from the registry (clean shutdown). */
export function deregisterInstance(root, file = REGISTRY) {
  const map = readAll(file);
  if (!(root in map)) return false;
  delete map[root];
  return writeAll(map, file);
}

/** All registered instances as an array. `isAlive` filters dead pids (default: real process check). */
export function listInstances({ file = REGISTRY, isAlive } = {}) {
  const all = Object.values(readAll(file));
  if (!isAlive) return all;
  return all.filter((i) => isAlive(i.pid));
}
