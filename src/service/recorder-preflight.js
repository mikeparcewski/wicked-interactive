// recorder-preflight.js — is the demo recorder's browser actually installed? (F-RECON-012)
//
// The recorder (demo.js) drives Playwright's bundled Chromium. Installing the npm package does
// NOT provision a browser — `playwright install` does — and nothing in the install chain ran it,
// so on a fresh machine every recording died on the first line (`browserType.launch: Executable
// doesn't exist at …/chromium_headless_shell-<rev>/…`), the bus retried the deterministic failure
// three times in four seconds and dead-lettered it, and the UI blamed "the generation service".
//
// This module is the missing PREFLIGHT, in three parts:
//   1. `recorderBrowserStatus()` — a model-free, launch-free presence check. It asks the bundled
//      Playwright CLI what it would install (`install --dry-run <browser>` — a public, scriptable
//      contract that names every component incl. ffmpeg, which video recording needs) and checks
//      each install location for Playwright's own INSTALLATION_COMPLETE marker. No internals of
//      playwright-core are imported (the package is bundled; there is no stable registry export).
//   2. `ensureRecorderBrowser()` — provisions the missing components on first use with the SAME
//      bundled CLI (never `npx playwright`, which would fetch a different version whose browsers
//      the bridge does not use), with progress + a timeout, opt-out via WI_RECORDER_AUTO_INSTALL=0.
//   3. `RecorderError` / `classifyRecorderError()` — the TYPED failure every recorder surface
//      returns: a stable `code`, `retryable: false`, and a one-line `remedy`. A missing browser (or
//      a failing spec) is deterministic — replaying it is never useful — so the command loop acks
//      it instead of retrying into a dead letter (F-RECON-014), and crew/studio render the code.
//
// Cross-platform (CLAUDE.md mandate): the CLI is spawned via process.execPath (no shell), paths
// come from Playwright's own output, and the marker check is a plain fs lookup.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Stable machine-readable codes — the contract crew relays and studio renders. */
export const RECORDER_ERROR_CODES = Object.freeze({
  BROWSER_MISSING: "recorder_browser_missing",
  BROWSER_INSTALL_FAILED: "recorder_browser_install_failed",
  LAUNCH_FAILED: "recorder_launch_failed",
  SPEC_MISSING: "recording_spec_missing",
  SPEC_INVALID: "recording_spec_invalid",
  STEP_FAILED: "recording_step_failed",
  FAILED: "recording_failed",
  IN_FLIGHT: "recording_in_flight",
});

/** Playwright's own "this browser install finished" marker (written into the install location). */
export const INSTALL_MARKER = "INSTALLATION_COMPLETE";

/** Default cap for one provisioning run (a ~100 MB download on a slow link). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** The one-line remedy a human runs — the bundled CLI via this package, never a foreign `npx playwright`. */
export const DOCTOR_REMEDY = "wicked-interactive doctor --install";

/**
 * The env prefix a copy-pasteable remedy needs so it provisions into the SAME cache this bridge
 * launches from (F-RC1-121 / R-L7-d). `PLAYWRIGHT_BROWSERS_PATH` moves where Playwright LOOKS, not
 * only where it installs — a bare `doctor --install` run in a terminal fills the global cache while
 * a bridge spawned with the variable keeps looking under it and reports the browser missing.
 * Empty when the variable is unset (the default cache needs no prefix). POSIX `VAR=value cmd` form.
 */
export function browsersPathPrefix(env = process.env) {
  const p = String(env.PLAYWRIGHT_BROWSERS_PATH ?? "").trim();
  return p ? `PLAYWRIGHT_BROWSERS_PATH="${p.replace(/"/g, '\\"')}" ` : "";
}

/** `DOCTOR_REMEDY`, prefixed with the browsers path when one is in force — the remedy the wire and the doctor print. */
export function doctorRemedy(env = process.env) {
  return `${browsersPathPrefix(env)}${DOCTOR_REMEDY}`;
}

/**
 * A typed recorder failure. Deterministic by construction (`retryable: false`): the same spec on the
 * same machine replays the same failure, so the fix is the `remedy`, not a retry.
 */
export class RecorderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    this.source = "recorder";
    this.retryable = false;
    this.remedy = details.remedy ?? null;
    for (const [k, v] of Object.entries(details)) if (k !== "remedy" && v !== undefined) this[k] = v;
  }
  /** The wire shape — identical on `status.posted` (flattened), `error.raised.context` and HTTP bodies. */
  toJSON() { return recorderErrorPayload(this); }
}

const WIRE_FIELDS = ["remedy", "browser", "missing", "executable_path", "install_command", "playwright_version", "browsers_path", "step", "cause", "state", "started_at"];

/** Flatten a RecorderError (or any error) into the additive wire fields consumers key on. */
export function recorderErrorPayload(err) {
  const e = err instanceof RecorderError ? err : classifyRecorderError(err);
  const out = { code: e.code, source: "recorder", retryable: e.retryable === true, error: e.message };
  for (const f of WIRE_FIELDS) if (e[f] !== undefined && e[f] !== null) out[f] = e[f];
  return out;
}

/** The browser a `recordDemo` launch resolves to: Playwright picks the headless shell for headless runs. */
export function recorderBrowserName({ headless = true } = {}) {
  return headless ? "chromium-headless-shell" : "chromium";
}

/** Absolute path of the BUNDLED Playwright CLI (the version this bridge launches), or null. */
export function playwrightCliPath() {
  try {
    const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    return existsSync(cli) ? cli : null;
  } catch { return null; }
}

export function playwrightVersion() {
  try { return require("playwright/package.json").version || null; } catch { return null; }
}

/** WI_RECORDER_AUTO_INSTALL: default ON; "0" / "false" / "off" / "no" opts out (an operator who provisions browsers themselves). */
export function recorderAutoInstallEnabled(env = process.env) {
  const v = String(env.WI_RECORDER_AUTO_INSTALL ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

export function recorderInstallTimeoutMs(env = process.env) {
  const n = Number(env.WI_RECORDER_INSTALL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INSTALL_TIMEOUT_MS;
}

/**
 * The exact command that provisions `browser` for THIS bridge's Playwright (copy-pasteable), carrying
 * the `PLAYWRIGHT_BROWSERS_PATH` prefix whenever `env` has one so it lands where this bridge looks.
 */
export function recorderInstallCommand(browser, cli = playwrightCliPath(), env = process.env) {
  const cmd = cli ? `node "${cli}" install ${browser}` : `npx playwright@${playwrightVersion() || "latest"} install ${browser}`;
  return `${browsersPathPrefix(env)}${cmd}`;
}

/**
 * Parse `playwright install --dry-run` output into components. The CLI prints, per component:
 *   <Label> (playwright <name> v<revision>)
 *     Install location:    <dir>
 *     Download url:        …
 * Only the label + install-location lines are read; anything else is ignored.
 */
export function parseDryRun(stdout) {
  const components = [];
  let label = null;
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const loc = /^\s+Install location:\s*(.+?)\s*$/.exec(raw);
    if (loc) {
      if (label) {
        const m = /\(playwright ([a-z0-9-]+) v(\d+)\)/i.exec(label);
        components.push({ name: m ? m[1] : label.trim(), revision: m ? m[2] : null, label: label.trim(), dir: loc[1] });
        label = null;
      }
      continue;
    }
    if (raw.trim() && !/^\s/.test(raw)) label = raw;
  }
  return components;
}

/** Run a child process to completion (no shell). Resolves {code, stdout, stderr}; rejects on spawn error/timeout. */
function run(cmd, args, { timeoutMs, onLine, env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "", stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch { /* gone */ } rejectPromise(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs) : null;
    timer?.unref?.();
    const feed = (which) => (buf) => {
      const s = String(buf);
      if (which === "out") stdout += s; else stderr += s;
      if (onLine) for (const line of s.split(/[\r\n]+/)) if (line.trim()) onLine(line, which);
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    child.on("error", (e) => { if (timer) clearTimeout(timer); rejectPromise(e); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

/** Default probe: ask the bundled CLI what `browser` needs, check each location for the marker. */
export async function dryRunProbe(browser, { cli = playwrightCliPath(), env = process.env } = {}) {
  if (!cli) throw new Error("the bundled Playwright CLI (playwright/cli.js) could not be resolved — is the playwright dependency installed?");
  const { code, stdout, stderr } = await run(process.execPath, [cli, "install", "--dry-run", browser], { timeoutMs: 30_000, env });
  if (code !== 0) throw new Error(`playwright install --dry-run ${browser} exited ${code}: ${String(stderr || stdout).trim().slice(0, 300)}`);
  const components = parseDryRun(stdout);
  if (components.length === 0) throw new Error(`playwright install --dry-run ${browser} named no install locations (unexpected CLI output)`);
  return components.map((c) => ({ ...c, present: existsSync(join(c.dir, INSTALL_MARKER)) }));
}

// Presence is re-checked at most every few seconds per browser: the UI polls the install gate,
// and a probe is a child process (~0.3 s). `ensure` invalidates after provisioning.
const STATUS_TTL_MS = 5_000;
const statusCache = new Map();
export function invalidateRecorderStatusCache() { statusCache.clear(); }

function describeMissing(status) {
  const where = status.browsers_path ? `under ${status.browsers_path}` : "in Playwright's default browser cache";
  return `the recorder's browser is not installed — Playwright ${status.playwright_version ?? "?"} needs ` +
    `${status.missing.join(" + ")} ${where}. Run \`${DOCTOR_REMEDY}\` (or \`${status.install_command}\`), then Re-record.`;
}

/**
 * Presence snapshot for the browser a recording in `headless` mode launches.
 * @returns {Promise<object>} `{ ok, browser, headless, playwright_version, cli, components[], missing[],
 *   browsers_path, install_command, remedy, auto_install, checked_at, probe_error? }`
 */
export async function recorderBrowserStatus({ headless = true, probe = dryRunProbe, env = process.env, ttlMs = STATUS_TTL_MS } = {}) {
  const browser = recorderBrowserName({ headless });
  const cached = statusCache.get(browser);
  if (cached && Date.now() - cached.at < ttlMs) return cached.status;
  const cli = playwrightCliPath();
  const base = {
    browser, headless,
    playwright_version: playwrightVersion(),
    cli,
    browsers_path: env.PLAYWRIGHT_BROWSERS_PATH || null,
    install_command: recorderInstallCommand(browser, cli, env),
    remedy: doctorRemedy(env),
    auto_install: recorderAutoInstallEnabled(env),
    checked_at: new Date().toISOString(),
  };
  let status;
  try {
    const components = await probe(browser, { cli, env });
    const missing = components.filter((c) => !c.present).map((c) => c.name);
    status = { ok: missing.length === 0, ...base, components, missing };
  } catch (e) {
    // The probe itself failed (no CLI, odd output): report honestly as not-ok — the launch would
    // fail too — and carry the reason so an operator sees WHY instead of a bare "missing".
    status = { ok: false, ...base, components: [], missing: [browser], probe_error: e.message };
  }
  if (!status.ok) status.message = status.probe_error
    ? `the recorder's browser could not be verified: ${status.probe_error}`
    : describeMissing(status);
  statusCache.set(browser, { at: Date.now(), status });
  return status;
}

/** Build the typed missing-browser error from a not-ok status (shared by the HTTP gate and the materializer). */
export function missingBrowserError(status) {
  return new RecorderError(RECORDER_ERROR_CODES.BROWSER_MISSING, status.message || describeMissing(status), {
    remedy: status.remedy ?? DOCTOR_REMEDY,
    browser: status.browser,
    missing: status.missing,
    install_command: status.install_command,
    playwright_version: status.playwright_version,
    browsers_path: status.browsers_path,
  });
}

/**
 * Default installer: `node <bundled cli> install <browser>` — provisions the browser AND ffmpeg
 * into Playwright's cache (PLAYWRIGHT_BROWSERS_PATH honoured), streaming progress lines.
 */
export async function installRecorderBrowser({ browser, cli = playwrightCliPath(), onProgress, timeoutMs = recorderInstallTimeoutMs(), env = process.env } = {}) {
  if (!cli) throw new Error("the bundled Playwright CLI (playwright/cli.js) could not be resolved");
  let lastPercent = -1;
  const onLine = (line) => {
    const pct = /(\d{1,3})%\s+of\s+([\d.]+\s*\w+)/.exec(line);
    if (pct) {
      const percent = Number(pct[1]);
      if (percent - lastPercent < 5 && percent !== 100) return;   // throttle the bar
      lastPercent = percent;
      onProgress?.({ phase: "downloading", percent, size: pct[2], line: line.trim() });
      return;
    }
    if (/^Downloading|^Chrom|^FFmpeg|^Chrome/i.test(line.trim())) onProgress?.({ phase: "downloading", line: line.trim() });
  };
  // Playwright's npm-time opt-out must not stop an explicit install request.
  const childEnv = { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: undefined };
  delete childEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  const { code, stderr, stdout } = await run(process.execPath, [cli, "install", browser], { timeoutMs, onLine, env: childEnv });
  if (code !== 0) throw new Error(`playwright install ${browser} exited ${code}: ${String(stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400)}`);
}

/**
 * Preflight + (opt-out) provision. Resolves the ok status; throws a RecorderError when the
 * browser is missing and cannot (or may not) be installed.
 * @param {object} [opts]
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.autoInstall]   default WI_RECORDER_AUTO_INSTALL (on)
 * @param {Function} [opts.onProgress]   ({phase, message?, percent?, line?})
 * @param {number}  [opts.timeoutMs]
 * @param {Function} [opts.status]       injectable presence probe (tests)
 * @param {Function} [opts.install]      injectable installer (tests)
 */
export async function ensureRecorderBrowser({
  headless = true,
  autoInstall,
  onProgress,
  timeoutMs,
  status = recorderBrowserStatus,
  install = installRecorderBrowser,
  env = process.env,
} = {}) {
  const auto = autoInstall ?? recorderAutoInstallEnabled(env);
  let st = await status({ headless, env });
  if (st.ok) return st;
  if (st.probe_error || !auto) throw missingBrowserError(st);
  onProgress?.({
    phase: "installing",
    message: `Installing the recorder's browser (${st.missing.join(" + ")} for Playwright ${st.playwright_version ?? "?"}) — a one-time download, then the recording starts…`,
  });
  try {
    await install({ browser: st.browser, cli: st.cli, onProgress, timeoutMs: timeoutMs ?? recorderInstallTimeoutMs(env), env });
  } catch (e) {
    invalidateRecorderStatusCache();
    throw new RecorderError(RECORDER_ERROR_CODES.BROWSER_INSTALL_FAILED,
      `installing the recorder's browser failed: ${e.message}. Run \`${DOCTOR_REMEDY}\` (or \`${st.install_command}\`) and check the network, then Re-record.`,
      { remedy: DOCTOR_REMEDY, browser: st.browser, missing: st.missing, install_command: st.install_command, playwright_version: st.playwright_version, browsers_path: st.browsers_path, cause: e.message });
  }
  invalidateRecorderStatusCache();
  st = await status({ headless, env });
  if (!st.ok) {
    throw new RecorderError(RECORDER_ERROR_CODES.BROWSER_INSTALL_FAILED,
      `the install finished but ${st.missing.join(" + ")} is still not present — run \`${DOCTOR_REMEDY}\` and inspect its output.`,
      { remedy: DOCTOR_REMEDY, browser: st.browser, missing: st.missing, install_command: st.install_command, playwright_version: st.playwright_version, browsers_path: st.browsers_path });
  }
  onProgress?.({ phase: "installed", message: "Recorder browser installed — ready to record." });
  return st;
}

/**
 * Turn whatever the recorder threw into a RecorderError with a stable code + remedy. Every code is
 * terminal (retryable: false): the same spec on the same machine replays the same failure.
 */
export function classifyRecorderError(err, { headless = true } = {}) {
  if (err instanceof RecorderError) return err;
  const msg = String(err?.message ?? err ?? "unknown error");
  const browser = recorderBrowserName({ headless });
  const step = err?.recorderStep;
  const C = RECORDER_ERROR_CODES;
  const exe = /Executable doesn't exist at (.+?)(?:\r?\n|$)/.exec(msg);
  if (exe) {
    return new RecorderError(C.BROWSER_MISSING,
      `the recorder's browser is not installed (Playwright expected ${exe[1]}). Run \`${doctorRemedy()}\` (or \`${recorderInstallCommand(browser)}\`), then Re-record.`,
      { remedy: doctorRemedy(), browser, executable_path: exe[1], install_command: recorderInstallCommand(browser), playwright_version: playwrightVersion(), cause: firstLine(msg) });
  }
  if (/Playwright is not installed/i.test(msg)) {
    return new RecorderError(C.BROWSER_MISSING, msg, { remedy: doctorRemedy(), browser, install_command: recorderInstallCommand(browser), cause: firstLine(msg) });
  }
  if (/no demo\.spec\.mjs authored/i.test(msg)) {
    return new RecorderError(C.SPEC_MISSING,
      "no demo spec has been authored for this document yet — the governed run writes demo.spec.mjs from your brief; wait for it (or replay the request) before recording.",
      { remedy: "wait for the spec run to finish, then Re-record", cause: firstLine(msg) });
  }
  if (/must export an async run|Unexpected token|SyntaxError|Cannot find module|does not provide an export/i.test(msg) && !step) {
    return new RecorderError(C.SPEC_INVALID,
      `the demo spec could not be loaded: ${firstLine(msg)} — re-author the spec (ask for a change on the storyboard), then Re-record.`,
      { remedy: "re-author demo.spec.mjs, then Re-record", cause: firstLine(msg) });
  }
  if (step) {
    return new RecorderError(C.STEP_FAILED,
      `recording failed at step ${step.index} (${step.label}): ${firstLine(msg)} — the same spec replays the same failure; refine that step on the storyboard, then Re-record.`,
      { remedy: `refine step ${step.index} (${step.label}) via the storyboard, then Re-record`, step, cause: firstLine(msg) });
  }
  if (/browserType\.launch|Failed to launch|Browser closed|Target closed|spawn .* ENOENT/i.test(msg)) {
    return new RecorderError(C.LAUNCH_FAILED,
      `the recorder's browser could not be launched: ${firstLine(msg)} — run \`${DOCTOR_REMEDY}\` and inspect the bridge log, then Re-record.`,
      { remedy: DOCTOR_REMEDY, browser, cause: firstLine(msg) });
  }
  return new RecorderError(C.FAILED, `recording failed: ${firstLine(msg)} — inspect the bridge log, then Re-record.`,
    { remedy: "inspect the bridge log, then Re-record", cause: firstLine(msg) });
}

/** Strip Playwright's ASCII box + stack to the first meaningful line. */
function firstLine(msg) {
  const line = String(msg).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[╔╗╚╝║═]/.test(l));
  return (line || String(msg)).slice(0, 400);
}
