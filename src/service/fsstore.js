// fsstore.js — shared on-disk primitives for a document workspace. Kept separate so both
// workspace.js and structural.js can use them without importing each other (no cycle).

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = "versions.json";

/** Atomic write: temp file + rename (so a watcher never reads a half-written file). */
export function atomicWrite(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function loadManifest(dir) {
  return JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8"));
}

export function saveManifest(dir, manifest) {
  atomicWrite(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
}

export function readVersionHtml(dir, version) {
  return readFileSync(join(dir, `_v${version}.html`), "utf-8");
}
