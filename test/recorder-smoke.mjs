// recorder-smoke.mjs — the REAL recorder end to end, once the browser is provisioned (CI job
// `recorder-provision`, after `wicked-interactive doctor --install`). Not part of `npm test`
// (which stays browser-free): this launches Playwright's headless shell against a local page,
// records a two-step demo and asserts the version + webm landed. Proves the install path the
// preflight provisions is the one the recorder actually launches (F-RECON-012).
//
//   PLAYWRIGHT_BROWSERS_PATH=<cache> node test/recorder-smoke.mjs

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { initWorkspace, loadManifest } from "../src/service/workspace.js";
import { recordDemo, DEMO_SPEC, findFfmpeg } from "../src/service/demo.js";
import { recorderBrowserStatus } from "../src/service/recorder-preflight.js";

const status = await recorderBrowserStatus({ headless: true, ttlMs: 0 });
if (!status.ok) {
  console.error("recorder browser not installed:", status.message);
  process.exit(2);
}

// The page carries a LARGE animation (a block sweeping the viewport every 2 s) so the clip has
// unmistakable motion wherever the recorder is NOT holding a frame — `freezedetect` below then
// measures the recorder's own dead air, not the page's stillness, and a small ticker would sit
// under its noise floor (wicked-interactive#211: static share, caption coverage).
const page = `<!doctype html><html><head><style>@keyframes sweep{from{transform:translateX(0)}to{transform:translateX(1000px)}}` +
  `#mover{position:fixed;top:120px;left:0;width:240px;height:240px;background:#2563eb;animation:sweep 2s linear infinite alternate}</style></head>` +
  `<body><h1 id="title">Smoke</h1><button id="go" onclick="document.getElementById('title').textContent='Clicked'">Go</button><div id="mover"></div></body></html>`;
const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const dir = mkdtempSync(join(tmpdir(), "wi-rec-smoke-"));
initWorkspace(dir, "<section><h1>Learning…</h1></section>", { kind: "demo" });
writeFileSync(join(dir, DEMO_SPEC), `
export const meta = { url: ${JSON.stringify(url)}, title: "Smoke demo", captionHoldMs: 1000 };
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
  const recFiles = readdirSync(join(dir, "recordings")).sort();
  const html = existsSync(join(dir, "_v1.html")) ? readFileSync(join(dir, "_v1.html"), "utf-8") : "";
  const ffmpeg = findFfmpeg();
  const mp4 = join(dir, "recordings", "_v1.mp4");
  const poster = join(dir, "recordings", "_v1-poster.jpg");
  // Static share of the landed clip: frozen seconds (freezedetect, ≥ 1 s at noise 0.001) over its
  // duration. The page animates continuously, so a frozen second is recorder dead air — the #211
  // measure (the RC1 clip scored 0.887, RC2 0.433).
  let staticShare = null;
  if (ffmpeg && existsSync(webm)) {
    const fd = spawnSync(ffmpeg, ["-i", webm, "-vf", "freezedetect=n=0.001:d=1", "-f", "null", "-"], { encoding: "utf-8", timeout: 120_000 });
    const log = String(fd.stderr || "");
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log);
    const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
    const frozen = [...log.matchAll(/freeze_duration:\s*([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    staticShare = seconds > 0 ? frozen / seconds : null;
  }
  const checks = [
    ["version landed", out.version === 1 && manifest.head === 1],
    ["two steps ran", steps.length === 2],
    ["webm exists", existsSync(webm)],
    ["webm non-empty", existsSync(webm) && statSync(webm).size > 1000],
    ["storyboard html", existsSync(join(dir, "_v1.html"))],
    ["no orphan page@*.webm and no failed attempt after a landing", !recFiles.some((f) => f.startsWith("page@") || f.startsWith("_attempt-"))],
    // With ffmpeg present (the preflight requires it) the storyboard serves what was produced (#211).
    ...(ffmpeg ? [
      ["mp4 produced", existsSync(mp4)],
      ["poster produced", existsSync(poster)],
      ["storyboard lists the mp4 first and carries the poster", /poster="[^"]*_v1-poster\.jpg"/.test(html) && html.indexOf('type="video/mp4"') > 0 && html.indexOf('type="video/mp4"') < html.indexOf('type="video/webm"')],
      ["static share < 0.3", staticShare != null && staticShare < 0.3],
    ] : []),
  ];
  for (const [name, ok] of checks) { console.log(`${ok ? "ok" : "FAIL"} - ${name}`); if (!ok) code = 1; }
  console.log(JSON.stringify({ version: out.version, video: out.video, bytes: existsSync(webm) ? statSync(webm).size : 0, steps, recordings: recFiles, ffmpeg: Boolean(ffmpeg), static_share: staticShare }, null, 2));
} catch (e) {
  console.error("recording failed:", e.message);
  code = 1;
} finally {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
