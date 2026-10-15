// #302 — the demo recorder can launch an installed browser (WI_RECORDER_CHROME / WI_RECORDER_CHANNEL,
// or opts.executablePath / opts.channel). With nothing set it launches the bundled browser, as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recorderBrowserOverride, recorderLaunchLabel, recorderBrowserStatus, ensureRecorderBrowser,
  invalidateRecorderStatusCache, RECORDER_ERROR_CODES,
} from "../src/service/recorder-preflight.js";

test("nothing set: no override, the bundled browser", () => {
  assert.equal(recorderBrowserOverride({}), null);
  assert.equal(recorderBrowserOverride({ WI_RECORDER_CHROME: "  ", WI_RECORDER_CHANNEL: "" }), null);
  assert.equal(recorderLaunchLabel(null), "bundled chromium-headless-shell");
  assert.equal(recorderLaunchLabel(null, { headless: false }), "bundled chromium");
});

test("env: the executable path wins over the channel; opts win over the env", () => {
  assert.deepEqual(recorderBrowserOverride({ WI_RECORDER_CHANNEL: "chrome" }), { channel: "chrome" });
  assert.deepEqual(recorderBrowserOverride({ WI_RECORDER_CHROME: "/opt/chrome", WI_RECORDER_CHANNEL: "chrome" }), { executablePath: "/opt/chrome" });
  assert.deepEqual(recorderBrowserOverride({ WI_RECORDER_CHROME: "/opt/chrome" }, { channel: "msedge" }), { channel: "msedge" });
  assert.deepEqual(recorderBrowserOverride({ WI_RECORDER_CHANNEL: "chrome" }, { executablePath: "/x/chrome" }), { executablePath: "/x/chrome" });
});

test("with an override, the preflight probes Playwright's ffmpeg alone, never the bundled browser", async () => {
  invalidateRecorderStatusCache();
  const asked = [];
  const probe = async (browser) => { asked.push(browser); return [{ name: "ffmpeg", present: true, dir: "/c/ffmpeg-1013" }]; };
  const st = await recorderBrowserStatus({ probe, env: {}, ttlMs: 0, override: { channel: "chrome" } });
  assert.deepEqual(asked, ["ffmpeg"]);
  assert.equal(st.ok, true);
  assert.equal(st.browser, "ffmpeg");
  assert.equal(st.launches, 'installed browser (Playwright channel "chrome")');
});

test("an existing executable: ok once ffmpeg is present; a missing ffmpeg is installed alone", async () => {
  invalidateRecorderStatusCache();
  const dir = mkdtempSync(join(tmpdir(), "wi-302-"));
  const exe = join(dir, "Google Chrome");
  writeFileSync(exe, "");
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
  assert.equal(st.launches, `installed browser ${exe}`);
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
});

test("nothing set: the preflight still probes the bundled browser", async () => {
  invalidateRecorderStatusCache();
  const asked = [];
  const probe = async (browser) => { asked.push(browser); return [{ name: browser, present: true, dir: "/c" }]; };
  const st = await recorderBrowserStatus({ probe, env: {}, ttlMs: 0 });
  assert.deepEqual(asked, ["chromium-headless-shell"]);
  assert.equal(st.override, null);
});
