// pptx.js — export a version to a native, editable PowerPoint (ADR-0020). Thin Node wrapper
// over the vendored Python builder (vendor/pptx/html_to_pptx.py): the heavy lifting is
// python-pptx, so this is a LAZY dependency surfaced at export time — exactly like ffmpeg for
// GIF (a missing dep is a clean 400 with an install hint, never a crash, and never part of the
// install gate that blocks ordinary documents).

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { themesDir } from "./theme-source.js";
import { downloadBase } from "./export.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, "../../vendor/pptx/html_to_pptx.py");

export const PPTX_INSTALL = "pip install python-pptx";

/** First python interpreter that runs. */
export function findPython(override) {
  const candidates = [override, "python3", "python"].filter(Boolean);
  for (const cmd of candidates) {
    try { if (spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0) return cmd; } catch { /* try next */ }
  }
  return null;
}

/** Lazy preflight: a python interpreter AND python-pptx importable. */
export function pptxReady(override) {
  const python = findPython(override);
  if (!python) return { ok: false, python: null, hint: `install python3, then: ${PPTX_INSTALL}` };
  const r = spawnSync(python, ["-c", "import pptx"], { stdio: "ignore" });
  if (r.status !== 0) return { ok: false, python, hint: PPTX_INSTALL };
  return { ok: true, python };
}

/**
 * Build export_v{version}.pptx from the version's HTML. Throws PPTX_DEP_MISSING (caught as a
 * 400 upstream) when python-pptx isn't installed.
 * @returns {{ path: string, bytes: number, slides?: number }}
 */
export function exportPptx(dir, version, opts = {}) {
  const htmlPath = join(dir, `_v${version}.html`);
  if (!existsSync(htmlPath)) throw new Error(`version ${version} not found`);
  const ready = opts.ready || pptxReady(opts.python);
  if (!ready.ok) {
    const e = new Error(`PowerPoint export needs python-pptx — run: ${ready.hint}`);
    e.code = "PPTX_DEP_MISSING";
    throw e;
  }
  const exportsDir = join(dir, "exports");
  mkdirSync(exportsDir, { recursive: true });
  const outPath = join(exportsDir, `${downloadBase(dir, version)}.pptx`);
  const themeName = typeof opts.theme === "string" ? opts.theme : "corporate-light";
  const themeFile = join(themesDir(), `${themeName}.json`);
  const args = [BUILDER, htmlPath, outPath, ...(existsSync(themeFile) ? [themeFile] : [])];
  const r = spawnSync(ready.python, args, { encoding: "utf-8" });
  if (r.status !== 0) {
    const last = (r.stderr || "").trim().split("\n").pop() || "unknown error";
    throw new Error(`pptx build failed: ${last}`);
  }
  return { path: outPath, bytes: statSync(outPath).size };
}
