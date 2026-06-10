// pptx.test.js — native PowerPoint export (ADR-0020). Works whether or not python-pptx is
// installed: where it is, we build a real .pptx and validate it; where it isn't, we assert the
// clean PPTX_DEP_MISSING error (the lazy-dependency contract, mirroring ffmpeg/GIF).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace } from "../src/service/workspace.js";
import { exportPptx, pptxReady } from "../src/service/pptx.js";

const READY = pptxReady();

function ws() {
  const dir = mkdtempSync(join(tmpdir(), "wi-pptx-"));
  initWorkspace(dir, "<section><h1>Q3 Results</h1><p>Revenue grew 18%.</p><ul><li>Margin held</li></ul></section><section><h2>Next</h2><p>Hire two AEs.</p></section>");
  return dir;
}

test("pptxReady reports a shape with ok + (python | hint)", () => {
  const r = pptxReady();
  assert.equal(typeof r.ok, "boolean");
  if (r.ok) assert.ok(r.python, "ready → names the python interpreter");
  else assert.ok(r.hint, "not ready → carries an install hint");
});

test("exportPptx on a missing version throws", () => {
  const dir = ws();
  try {
    assert.throws(() => exportPptx(dir, 99, { ready: READY }), /version 99 not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test(READY.ok ? "exportPptx builds a valid .pptx (PK zip) from a version" : "exportPptx throws PPTX_DEP_MISSING when python-pptx is absent", () => {
  const dir = ws();
  try {
    if (READY.ok) {
      const { path, bytes } = exportPptx(dir, 0, { ready: READY });
      assert.ok(bytes > 1000, "a real deck is more than a kilobyte");
      const head = readFileSync(path);
      assert.equal(head[0], 0x50); assert.equal(head[1], 0x4b); // "PK" — .pptx is a zip
    } else {
      const e = assert.throws(() => exportPptx(dir, 0, { ready: READY }));
      assert.equal(e.code, "PPTX_DEP_MISSING");
      assert.match(e.message, /python-pptx/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
