// recorder-smoke.mjs — the REAL recorder end to end, once the browser is provisioned (CI job
// `recorder-provision`, after `wicked-interactive doctor --install`). Not part of `npm test`
// (which stays browser-free): this launches Playwright's headless shell against a local page,
// records a two-step demo and asserts the version + webm landed. Proves the install path the
// preflight provisions is the one the recorder actually launches (F-RECON-012).
//
//   PLAYWRIGHT_BROWSERS_PATH=<cache> node test/recorder-smoke.mjs

import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import { recordDemo, DEMO_SPEC } from "../src/service/demo.js";
import { recorderBrowserStatus } from "../src/service/recorder-preflight.js";

const status = await recorderBrowserStatus({ headless: true, ttlMs: 0 });
if (!status.ok) {
  console.error("recorder browser not installed:", status.message);
  process.exit(2);
}

const page = `<!doctype html><html><body><h1 id="title">Smoke</h1><button id="go" onclick="document.getElementById('title').textContent='Clicked'">Go</button></body></html>`;
const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const dir = mkdtempSync(join(tmpdir(), "wi-rec-smoke-"));
initWorkspace(dir, "<section><h1>Learning…</h1></section>", { kind: "demo" });
writeFileSync(join(dir, DEMO_SPEC), `
export const meta = { url: ${JSON.stringify(url)}, title: "Smoke demo", captionHoldMs: 200 };
export async function run({ page, step, meta }) {
  await page.goto(meta.url);
  await step("Land on the page", async () => { await page.waitForSelector("#title"); }, { say: "We land on the page." });
  await step("Click go", async () => { await page.click("#go"); await page.waitForFunction(() => document.getElementById("title").textContent === "Clicked"); }, { say: "One click." });
}
`);

let code = 0;
try {
  const steps = [];
  const out = await recordDemo(dir, { documentId: "smoke", headless: true, onStep: (s) => steps.push(s.label) });
  const webm = join(dir, "recordings", out.video);
  const manifest = loadManifest(dir);
  const checks = [
    ["version landed", out.version === 1 && manifest.head === 1],
    ["two steps ran", steps.length === 2],
    ["webm exists", existsSync(webm)],
    ["webm non-empty", existsSync(webm) && statSync(webm).size > 1000],
    ["storyboard html", existsSync(join(dir, "_v1.html"))],
  ];
  for (const [name, ok] of checks) { console.log(`${ok ? "ok" : "FAIL"} - ${name}`); if (!ok) code = 1; }
  console.log(JSON.stringify({ version: out.version, video: out.video, bytes: existsSync(webm) ? statSync(webm).size : 0, steps }, null, 2));
} catch (e) {
  console.error("recording failed:", e.message);
  code = 1;
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
