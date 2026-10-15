// #302 — the demo recorder can launch an installed browser (WI_RECORDER_CHROME, its executable).
// With nothing set it launches the bundled browser, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recorderBrowserOverride, recorderLaunchLabel, recorderBrowserStatus, ensureRecorderBrowser,
  invalidateRecorderStatusCache, classifyRecorderError, RECORDER_ERROR_CODES, RECORDER_CHROME_REMEDY,
} from "../src/service/recorder-preflight.js";
import { themeBrowserError } from "../src/service/theme-grab.js";

function installedBrowser() {
  const dir = mkdtempSync(join(tmpdir(), "wi-302-"));
  const exe = join(dir, "Google Chrome");
  writeFileSync(exe, "");
  return exe;
}

test("nothing set: no override, the bundled browser", () => {
  assert.equal(recorderBrowserOverride({}), null);
  assert.equal(recorderBrowserOverride({ WI_RECORDER_CHROME: "  " }), null);
  assert.equal(recorderLaunchLabel(null), "bundled chromium-headless-shell");
  assert.equal(recorderLaunchLabel(null, { headless: false }), "bundled chromium");
});

test("WI_RECORDER_CHROME names the executable", () => {
  assert.deepEqual(recorderBrowserOverride({ WI_RECORDER_CHROME: " /opt/chrome " }), { executablePath: "/opt/chrome" });
  assert.equal(recorderLaunchLabel({ executablePath: "/opt/chrome" }), "installed browser /opt/chrome");
});

test("with an override, the preflight probes Playwright's ffmpeg alone, never the bundled browser; the mode is kept", async () => {
  invalidateRecorderStatusCache();
  const exe = installedBrowser();
  const asked = [];
  const probe = async (browser) => { asked.push(browser); return [{ name: "ffmpeg", present: true, dir: "/c/ffmpeg-1013" }]; };
  const env = { WI_RECORDER_CHROME: exe };
  const st = await recorderBrowserStatus({ probe, env });
  assert.deepEqual(asked, ["ffmpeg"]);
  assert.equal(st.ok, true);
  assert.equal(st.browser, "ffmpeg");
  assert.equal(st.headless, true);
  assert.equal(st.launches, `installed browser ${exe}`);
  const headed = await recorderBrowserStatus({ probe, env, headless: false });
  assert.equal(headed.headless, false, "a headed status is not the cached headless one");
});

test("an existing executable: a missing ffmpeg is installed alone, then the recorder is ready", async () => {
  invalidateRecorderStatusCache();
  const exe = installedBrowser();
  const env = { WI_RECORDER_CHROME: exe };
  let present = false;
  const installed = [];
  const status = (o) => recorderBrowserStatus({ ...o, ttlMs: 0, probe: async () => [{ name: "ffmpeg", present, dir: "/c/ffmpeg" }] });
  const st = await ensureRecorderBrowser({
    env, autoInstall: true, status,
    install: async ({ browser }) => { installed.push(browser); present = true; },
  });
  assert.deepEqual(installed, ["ffmpeg"]);
  assert.equal(st.ok, true);
});

test("a configured executable that does not exist is refused, and nothing is downloaded", async () => {
  invalidateRecorderStatusCache();
  const env = { WI_RECORDER_CHROME: "/nowhere/Google Chrome" };
  let probed = false;
  let installed = false;
  const status = (o) => recorderBrowserStatus({ ...o, ttlMs: 0, probe: async () => { probed = true; return []; } });
  await assert.rejects(
    ensureRecorderBrowser({ env, autoInstall: true, status, install: async () => { installed = true; } }),
    (e) => e.code === RECORDER_ERROR_CODES.BROWSER_MISSING && /WI_RECORDER_CHROME names \/nowhere\/Google Chrome/.test(e.message),
  );
  assert.equal(probed, false);
  assert.equal(installed, false);
  const st = await status({ env });
  assert.equal(st.remedy, RECORDER_CHROME_REMEDY, "the remedy is the setting, not doctor --install");
  assert.equal(st.install_command, null);
});

test("nothing set: the preflight still probes the bundled browser", async () => {
  invalidateRecorderStatusCache();
  const asked = [];
  const probe = async (browser) => { asked.push(browser); return [{ name: browser, present: true, dir: "/c" }]; };
  const st = await recorderBrowserStatus({ probe, env: {}, ttlMs: 0 });
  assert.deepEqual(asked, ["chromium-headless-shell"]);
  assert.equal(st.override, null);
  assert.equal(st.launches, "bundled chromium-headless-shell");
});

test("a launch that finds no configured executable is the setting's to fix, never a download", () => {
  const prev = process.env.WI_RECORDER_CHROME;
  process.env.WI_RECORDER_CHROME = "/gone/Google Chrome";
  try {
    // Playwright's own wording for a custom executablePath (browserType.ts).
    const e = classifyRecorderError(new Error("browserType.launch: Failed to launch chromium because executable doesn't exist at /gone/Google Chrome\n"));
    assert.equal(e.code, RECORDER_ERROR_CODES.BROWSER_MISSING);
    assert.match(e.message, /WI_RECORDER_CHROME names \/gone\/Google Chrome/);
    assert.doesNotMatch(e.message, /doctor --install/);
    assert.equal(e.remedy, RECORDER_CHROME_REMEDY);
    const themed = themeBrowserError(new Error("browserType.launch: Failed to launch chromium because executable doesn't exist at /gone/Google Chrome\n"));
    assert.match(themed.message, /WI_RECORDER_CHROME names \/gone\/Google Chrome/);
    assert.match(themed.message, /then Learn again\.$/);
    assert.doesNotMatch(themed.message, /doctor --install/);
    assert.equal(themed.remedy, RECORDER_CHROME_REMEDY);
  } finally {
    if (prev === undefined) delete process.env.WI_RECORDER_CHROME; else process.env.WI_RECORDER_CHROME = prev;
  }
});
