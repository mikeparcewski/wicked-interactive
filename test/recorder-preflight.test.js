// recorder-preflight.test.js — the demo recorder's browser gate (F-RECON-012 / F-RECON-014).
//
// A fresh `npm install` never provisions Playwright's browser; the recorder must SAY SO (typed,
// with the one-line remedy), provision it when allowed, and never spin retries on a
// deterministic failure. Everything here is hermetic: the probe/installer are injected, and the
// one test that touches the real bundled CLI runs `install --dry-run` against an EMPTY temp
// browsers path (no download, never the developer's cache).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RECORDER_ERROR_CODES, RecorderError, INSTALL_MARKER, DOCTOR_REMEDY, doctorRemedy, browsersPathPrefix,
  recorderBrowserName, recorderAutoInstallEnabled, recorderInstallTimeoutMs, recorderInstallCommand,
  parseDryRun, dryRunProbe, recorderBrowserStatus, ensureRecorderBrowser, invalidateRecorderStatusCache,
  classifyRecorderError, recorderErrorPayload, missingBrowserError, playwrightCliPath, playwrightVersion,
} from "../src/service/recorder-preflight.js";

const C = RECORDER_ERROR_CODES;

/** A fake probe: components named by `present` map, dirs under a temp root. */
function fakeProbe(present) {
  return async (browser) => [
    { name: browser, revision: "1234", label: `${browser} (playwright ${browser} v1234)`, dir: `/fake/${browser}-1234`, present: !!present[browser] },
    { name: "ffmpeg", revision: "1011", label: "FFmpeg (playwright ffmpeg v1011)", dir: "/fake/ffmpeg-1011", present: !!present.ffmpeg },
  ];
}
const noCache = { ttlMs: 0 };

test("recorderBrowserName: headless recordings launch the headless shell, headed ones full chromium", () => {
  assert.equal(recorderBrowserName(), "chromium-headless-shell");
  assert.equal(recorderBrowserName({ headless: true }), "chromium-headless-shell");
  assert.equal(recorderBrowserName({ headless: false }), "chromium");
});

test("auto-install defaults ON and honours the documented opt-outs", () => {
  assert.equal(recorderAutoInstallEnabled({}), true);
  for (const v of ["0", "false", "off", "no", " OFF "]) assert.equal(recorderAutoInstallEnabled({ WI_RECORDER_AUTO_INSTALL: v }), false, v);
  assert.equal(recorderAutoInstallEnabled({ WI_RECORDER_AUTO_INSTALL: "1" }), true);
  assert.equal(recorderInstallTimeoutMs({}), 10 * 60 * 1000);
  assert.equal(recorderInstallTimeoutMs({ WI_RECORDER_INSTALL_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(recorderInstallTimeoutMs({ WI_RECORDER_INSTALL_TIMEOUT_MS: "nope" }), 10 * 60 * 1000);
});

test("parseDryRun reads every component + install location from the CLI's dry-run output", () => {
  const out = [
    "Chrome Headless Shell 151.0.7922.34 (playwright chromium-headless-shell v1234)",
    "  Install location:    /tmp/pw/chromium_headless_shell-1234",
    "  Download url:        https://example.invalid/x.zip",
    "",
    "FFmpeg (playwright ffmpeg v1011)",
    "  Install location:    /tmp/pw/ffmpeg-1011",
    "  Download url:        https://example.invalid/y.zip",
    "  Download fallback 1: https://example.invalid/z.zip",
  ].join("\n");
  assert.deepEqual(parseDryRun(out).map(({ name, revision, dir }) => ({ name, revision, dir })), [
    { name: "chromium-headless-shell", revision: "1234", dir: "/tmp/pw/chromium_headless_shell-1234" },
    { name: "ffmpeg", revision: "1011", dir: "/tmp/pw/ffmpeg-1011" },
  ]);
  assert.deepEqual(parseDryRun(""), []);
  // Windows paths (drive letter, backslashes) survive intact.
  const win = "Chromium 1 (playwright chromium v9)\r\n  Install location:    C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium-9\r\n";
  assert.equal(parseDryRun(win)[0].dir, "C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium-9");
});

test("status: missing components → ok:false with the typed remedy fields (injected probe)", async () => {
  invalidateRecorderStatusCache();
  const st = await recorderBrowserStatus({ headless: true, probe: fakeProbe({}), env: { PLAYWRIGHT_BROWSERS_PATH: "/fake" }, ...noCache });
  assert.equal(st.ok, false);
  assert.equal(st.browser, "chromium-headless-shell");
  assert.deepEqual(st.missing, ["chromium-headless-shell", "ffmpeg"]);
  assert.equal(st.browsers_path, "/fake");
  // PLAYWRIGHT_BROWSERS_PATH in force ⇒ BOTH copy-pasteable lines carry it (F-RC1-121 / R-L7-d):
  // a bare `doctor --install` would fill the global cache while this bridge looks under /fake.
  assert.equal(st.remedy, `PLAYWRIGHT_BROWSERS_PATH="/fake" ${DOCTOR_REMEDY}`);
  assert.equal(st.remedy, doctorRemedy({ PLAYWRIGHT_BROWSERS_PATH: "/fake" }));
  assert.match(st.install_command, /^PLAYWRIGHT_BROWSERS_PATH="\/fake" node ".*" install chromium-headless-shell$/);
  assert.match(st.message, /not installed/);
  assert.match(st.message, /doctor --install/);
  assert.equal(typeof st.playwright_version, "string");
});

test("status: only ffmpeg missing is still not ok (video capture needs it) and names exactly what is missing", async () => {
  invalidateRecorderStatusCache();
  const st = await recorderBrowserStatus({ headless: true, probe: fakeProbe({ "chromium-headless-shell": true }), ...noCache });
  assert.equal(st.ok, false);
  assert.deepEqual(st.missing, ["ffmpeg"]);
});

test("status: everything present → ok:true; headed mode asks for full chromium", async () => {
  invalidateRecorderStatusCache();
  const st = await recorderBrowserStatus({ headless: false, probe: fakeProbe({ chromium: true, ffmpeg: true }), ...noCache });
  assert.equal(st.ok, true);
  assert.equal(st.browser, "chromium");
  assert.deepEqual(st.missing, []);
  assert.equal(st.message, undefined);
});

test("status: a probe failure is reported honestly as not-ok with the reason, never as 'present'", async () => {
  invalidateRecorderStatusCache();
  const st = await recorderBrowserStatus({ probe: async () => { throw new Error("cli exploded"); }, ...noCache });
  assert.equal(st.ok, false);
  assert.equal(st.probe_error, "cli exploded");
  assert.match(st.message, /could not be verified: cli exploded/);
});

test("status is cached briefly per browser and invalidated on demand", async () => {
  invalidateRecorderStatusCache();
  let calls = 0;
  const probe = async (b) => { calls += 1; return fakeProbe({ [b]: true, ffmpeg: true })(b); };
  await recorderBrowserStatus({ probe, ttlMs: 60_000 });
  await recorderBrowserStatus({ probe, ttlMs: 60_000 });
  assert.equal(calls, 1, "second call inside the TTL is served from cache");
  invalidateRecorderStatusCache();
  await recorderBrowserStatus({ probe, ttlMs: 60_000 });
  assert.equal(calls, 2);
  invalidateRecorderStatusCache();
});

test("ensure: missing + auto-install OFF → typed recorder_browser_missing, installer never called", async () => {
  invalidateRecorderStatusCache();
  let installs = 0;
  await assert.rejects(
    ensureRecorderBrowser({ autoInstall: false, status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe({}), ...noCache }), install: async () => { installs += 1; } }),
    (e) => {
      assert.ok(e instanceof RecorderError);
      assert.equal(e.code, C.BROWSER_MISSING);
      assert.equal(e.retryable, false);
      assert.equal(e.remedy, DOCTOR_REMEDY);
      assert.deepEqual(e.missing, ["chromium-headless-shell", "ffmpeg"]);
      return true;
    },
  );
  assert.equal(installs, 0);
});

test("ensure: env opt-out WI_RECORDER_AUTO_INSTALL=0 is honoured when autoInstall is not given", async () => {
  invalidateRecorderStatusCache();
  let installs = 0;
  await assert.rejects(
    ensureRecorderBrowser({ env: { WI_RECORDER_AUTO_INSTALL: "0" }, status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe({}), ...noCache }), install: async () => { installs += 1; } }),
    (e) => e.code === C.BROWSER_MISSING,
  );
  assert.equal(installs, 0);
});

test("ensure: missing + auto-install ON → installs the exact browser, reports progress, returns ok", async () => {
  invalidateRecorderStatusCache();
  const present = {};
  const progress = [];
  let installedBrowser = null;
  const st = await ensureRecorderBrowser({
    headless: true, autoInstall: true,
    status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe(present), ...noCache }),
    install: async ({ browser, onProgress }) => {
      installedBrowser = browser;
      onProgress({ phase: "downloading", percent: 50, size: "100 MiB", line: "|■■■■| 50% of 100 MiB" });
      present[browser] = true; present.ffmpeg = true;   // the install lands both components
    },
    onProgress: (p) => progress.push(p.phase),
  });
  assert.equal(installedBrowser, "chromium-headless-shell");
  assert.equal(st.ok, true);
  assert.deepEqual(progress, ["installing", "downloading", "installed"]);
});

test("ensure: already present → no install, no progress", async () => {
  invalidateRecorderStatusCache();
  let installs = 0; const progress = [];
  const st = await ensureRecorderBrowser({ autoInstall: true, status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe({ "chromium-headless-shell": true, ffmpeg: true }), ...noCache }), install: async () => { installs += 1; }, onProgress: (p) => progress.push(p) });
  assert.equal(st.ok, true);
  assert.equal(installs, 0);
  assert.deepEqual(progress, []);
});

test("ensure: installer failure → typed recorder_browser_install_failed carrying the cause + remedy", async () => {
  invalidateRecorderStatusCache();
  await assert.rejects(
    ensureRecorderBrowser({ autoInstall: true, status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe({}), ...noCache }), install: async () => { throw new Error("getaddrinfo ENOTFOUND cdn.playwright.dev"); } }),
    (e) => {
      assert.equal(e.code, C.BROWSER_INSTALL_FAILED);
      assert.equal(e.retryable, false);
      assert.match(e.message, /ENOTFOUND/);
      assert.equal(e.remedy, DOCTOR_REMEDY);
      assert.equal(e.cause, "getaddrinfo ENOTFOUND cdn.playwright.dev");
      return true;
    },
  );
});

test("ensure: an install that 'succeeds' but leaves the browser missing is still a typed failure", async () => {
  invalidateRecorderStatusCache();
  await assert.rejects(
    ensureRecorderBrowser({ autoInstall: true, status: (o) => recorderBrowserStatus({ ...o, probe: fakeProbe({}), ...noCache }), install: async () => {} }),
    (e) => e.code === C.BROWSER_INSTALL_FAILED && /still not present/.test(e.message),
  );
});

test("classify: Playwright's 'Executable doesn't exist' (with its ASCII box) → recorder_browser_missing, path extracted, box stripped", () => {
  const msg = "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell\n" +
    "╔════════════════════════════════════════════════════════════╗\n║ Looks like Playwright was just installed or updated.       ║\n║ Please run the following command to download new browsers: ║\n║                                                            ║\n║     npx playwright install                                 ║\n╚════════════════════════════════════════════════════════════╝";
  const e = classifyRecorderError(new Error(msg));
  assert.equal(e.code, C.BROWSER_MISSING);
  assert.equal(e.retryable, false);
  assert.equal(e.executable_path, "/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");
  assert.match(e.message, /doctor --install/);
  assert.doesNotMatch(e.message, /[╔║╚]/, "the box never reaches the thread");
  assert.doesNotMatch(e.cause, /[╔║╚]/);
  assert.match(e.install_command, /install chromium-headless-shell$/);
});

test("classify: the other recorder failures get stable terminal codes + remedies", () => {
  assert.equal(classifyRecorderError(new Error("no demo.spec.mjs authored yet — the agent must write the spec before recording")).code, C.SPEC_MISSING);
  assert.equal(classifyRecorderError(new Error("demo.spec.mjs must export an async run({ page, step, meta })")).code, C.SPEC_INVALID);
  assert.equal(classifyRecorderError(new Error("browserType.launch: Failed to launch: spawn EACCES")).code, C.LAUNCH_FAILED);
  const stepErr = new Error("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('x')");
  stepErr.recorderStep = { index: 3, label: "Open the scope" };
  const s = classifyRecorderError(stepErr);
  assert.equal(s.code, C.STEP_FAILED);
  assert.deepEqual(s.step, { index: 3, label: "Open the scope" });
  assert.match(s.message, /step 3 \(Open the scope\)/);
  assert.match(s.remedy, /refine step 3/);
  assert.equal(classifyRecorderError(new Error("disk full")).code, C.FAILED);
  for (const e of [stepErr, new Error("disk full")]) assert.equal(classifyRecorderError(e).retryable, false);
  // Already-typed errors pass through untouched.
  const typed = new RecorderError(C.IN_FLIGHT, "busy");
  assert.equal(classifyRecorderError(typed), typed);
});

test("recorderErrorPayload is the flat wire shape: code / source / retryable / error / remedy (+ details)", () => {
  const e = new RecorderError(C.BROWSER_MISSING, "gone", { remedy: DOCTOR_REMEDY, browser: "chromium-headless-shell", missing: ["ffmpeg"], install_command: "node cli install x" });
  const w = recorderErrorPayload(e);
  assert.deepEqual(w, {
    code: "recorder_browser_missing", source: "recorder", retryable: false, error: "gone",
    remedy: DOCTOR_REMEDY, browser: "chromium-headless-shell", missing: ["ffmpeg"], install_command: "node cli install x",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), w, "toJSON is the same shape");
  // A plain error is classified on the way to the wire.
  assert.equal(recorderErrorPayload(new Error("no demo.spec.mjs authored yet")).code, C.SPEC_MISSING);
});

test("missingBrowserError builds the typed error from a not-ok status", async () => {
  invalidateRecorderStatusCache();
  const st = await recorderBrowserStatus({ probe: fakeProbe({}), env: { PLAYWRIGHT_BROWSERS_PATH: "/fake" }, ...noCache });
  const e = missingBrowserError(st);
  assert.equal(e.code, C.BROWSER_MISSING);
  assert.deepEqual(e.missing, ["chromium-headless-shell", "ffmpeg"]);
  assert.equal(e.browsers_path, "/fake");
  assert.equal(e.remedy, doctorRemedy({ PLAYWRIGHT_BROWSERS_PATH: "/fake" }), "the typed error carries the prefixed remedy");
  assert.match(e.install_command, /^PLAYWRIGHT_BROWSERS_PATH="\/fake" /);
});

test("install_command / remedy: the PLAYWRIGHT_BROWSERS_PATH prefix appears iff the variable is set (R-L7-d)", () => {
  const cli = playwrightCliPath();
  // Unset ⇒ no prefix: the default cache needs none, and the remedy stays the bare doctor line.
  assert.equal(browsersPathPrefix({}), "");
  assert.equal(doctorRemedy({}), DOCTOR_REMEDY);
  assert.equal(recorderInstallCommand("chromium-headless-shell", cli, {}), `node "${cli}" install chromium-headless-shell`);
  // Set ⇒ the POSIX `VAR=value cmd` prefix, value quoted (state-home paths may carry spaces).
  const env = { PLAYWRIGHT_BROWSERS_PATH: "/state home/interactive/recorder-browsers" };
  assert.equal(browsersPathPrefix(env), 'PLAYWRIGHT_BROWSERS_PATH="/state home/interactive/recorder-browsers" ');
  assert.equal(doctorRemedy(env), 'PLAYWRIGHT_BROWSERS_PATH="/state home/interactive/recorder-browsers" wicked-interactive doctor --install');
  assert.equal(recorderInstallCommand("chromium-headless-shell", cli, env),
    `PLAYWRIGHT_BROWSERS_PATH="/state home/interactive/recorder-browsers" node "${cli}" install chromium-headless-shell`);
  // Blank / whitespace counts as unset — never an empty `PLAYWRIGHT_BROWSERS_PATH=""` prefix.
  assert.equal(browsersPathPrefix({ PLAYWRIGHT_BROWSERS_PATH: "  " }), "");
  // The npx fallback (no bundled cli) is prefixed the same way.
  assert.match(recorderInstallCommand("chromium", null, env), /^PLAYWRIGHT_BROWSERS_PATH="[^"]+" npx playwright@/);
});

// ── the real bundled CLI, against an EMPTY temp browsers path (dry-run: nothing is downloaded) ──

test("bundled Playwright resolves: cli.js path + version + install command point at THIS package's playwright", () => {
  const cli = playwrightCliPath();
  assert.ok(cli && /playwright[\\/]cli\.js$/.test(cli), cli);
  assert.match(playwrightVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(recorderInstallCommand("chromium-headless-shell", cli, {}), `node "${cli}" install chromium-headless-shell`);
  assert.match(recorderInstallCommand("chromium", null, {}), /^npx playwright@/, "no cli → an explicit pinned npx fallback");
});

test("real dry-run probe: names the headless shell + ffmpeg under an injected (empty) browsers path → missing; a marker makes it present", async () => {
  const browsersPath = mkdtempSync(join(tmpdir(), "wi-pw-browsers-"));
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
  try {
    const comps = await dryRunProbe("chromium-headless-shell", { env });
    const names = comps.map((c) => c.name);
    assert.ok(names.includes("chromium-headless-shell"), JSON.stringify(comps));
    assert.ok(names.includes("ffmpeg"), "video capture's ffmpeg rides along with the headless shell");
    for (const c of comps) {
      assert.ok(c.dir.startsWith(browsersPath), `install location honours PLAYWRIGHT_BROWSERS_PATH: ${c.dir}`);
      assert.equal(c.present, false);
    }
    // Seed Playwright's own completion marker → present, without any download.
    for (const c of comps) { mkdirSync(c.dir, { recursive: true }); writeFileSync(join(c.dir, INSTALL_MARKER), ""); }
    const again = await dryRunProbe("chromium-headless-shell", { env });
    assert.ok(again.every((c) => c.present), JSON.stringify(again));
    invalidateRecorderStatusCache();
    const st = await recorderBrowserStatus({ headless: true, env, ...noCache });
    assert.equal(st.ok, true, JSON.stringify(st));
    invalidateRecorderStatusCache();
  } finally {
    rmSync(browsersPath, { recursive: true, force: true });
  }
});

// ── M1 (review of #224): no shipped surface may still say `npx playwright install` ──────────
// A foreign `npx playwright install` fetches a DIFFERENT Playwright whose browsers this bridge
// never launches (ADR-0028) — an operator who follows it ends at "I installed it and doctor still
// says MISSING". Every shipped remedy must be the bundled one. Scans the published files
// (package.json `files`: bin/, src/, frontend/dist/) plus the skills the agent reads, and the
// JSON the install gate / doctor emit.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, PLAYWRIGHT_INSTALL } from "../src/service/preflight.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|md|json)$/.test(name)) out.push(p);
  }
  return out;
}

test("no shipped string contains `npx playwright install` — the remedy is always the bundled CLI (M1)", () => {
  const files = ["bin", "src", "skills", "frontend/dist"].flatMap((d) => { try { return walk(resolve(REPO, d)); } catch { return []; } });
  assert.ok(files.length > 20, `expected the shipped tree, scanned ${files.length} files`);
  const offenders = files.filter((f) => /npx playwright install/i.test(readFileSync(f, "utf-8"))).map((f) => f.slice(REPO.length + 1));
  assert.deepEqual(offenders, []);
  // The two JSON surfaces an operator/installer reads.
  assert.doesNotMatch(JSON.stringify(preflight()), /npx playwright install/);
  assert.match(PLAYWRIGHT_INSTALL, /^wicked-interactive doctor --install/);
  assert.doesNotMatch(recorderInstallCommand("chromium-headless-shell"), /npx playwright install/, "the exact command spawns the bundled cli.js");
});
