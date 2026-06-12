// theme-grab.js — the deterministic, model-free "grab a URL to a PDF" primitive
// (the service half of "learn a theme from a URL", ADR-0010/ADR-0020).
//
// Judgment (reading the captured design — palette, type scale, spacing, card treatment) is the
// AGENT's job and lives in the assist skill. This module does NOTHING intelligent: it points a
// headless browser at a LIVE https URL and prints it to PDF — the same `chrome --print-to-pdf`
// primitive export.js uses for a version's HTML, only the final argument is the live URL instead
// of `file://<html>`. We REUSE export.js's findChrome() so chrome discovery (and the WI_CHROME
// override / clear "no Chrome found" error) stays in one place.
//
// SSRF GUARD (security review). The URL is user-supplied and the service fetches it server-side,
// so before rendering we: (1) require http(s); (2) reject metadata/loopback hostnames; (3) resolve
// EVERY address for the host and reject if any is loopback, link-local (incl. the cloud metadata
// endpoint 169.254.169.254), private, ULA, CGNAT, or unspecified; (4) PIN the validated IP into
// Chrome via --host-resolver-rules so DNS can't be rebound between validation and fetch. This
// closes the direct (paste-the-metadata-URL) and DNS-rebinding vectors.
//
// REDIRECT-CHAIN PREFLIGHT (issue #21). Validating only the INITIAL host left a residual: headless
// Chrome `--print-to-pdf` FOLLOWS HTTP redirects, so a 302 from a validated public host to
// `http://169.254.169.254/` (or any private host) was followed and the internal response rendered.
// To close the main-document redirect vector portably (no OS-specific egress sandbox), we walk the
// redirect chain Node-side with `redirect: 'manual'` BEFORE handing anything to Chrome
// (resolveRedirectChain): every hop's URL — initial AND each `Location` — is re-validated through
// assertPublicUrl, and Chrome is pointed at (and IP-pinned to) the FINAL non-redirect URL. A
// redirect to a private/metadata host throws at the offending hop; loops/over-long chains throw on
// maxHops. RESIDUAL (still open): page SUBRESOURCES — img/css/script the FINAL page itself loads
// from a private host — are still fetched by Chrome and are NOT closed by this preflight (the
// preflight only follows the MAIN-document redirect chain, not the resources the rendered page
// pulls). Fully closing that requires network-egress restriction (a namespace/firewall limiting
// Chrome to public CIDRs); tracked as a follow-up. The renderer + validator + fetchImpl are
// injectable so CI needs no browser/network/DNS and the guard is unit-testable deterministically.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { findChrome as defaultFindChrome } from "./export.js";

// Hostnames that must never be fetched server-side regardless of how they resolve.
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

// Decode the IPv4 embedded in the tail of an IPv4-mapped/compatible IPv6, in EITHER dotted
// (`1.2.3.4`) or hex-pair (`0102:0304`) spelling. The WHATWG URL parser normalizes
// `::ffff:169.254.169.254` to the hex form `::ffff:a9fe:a9fe`, so the hex case is the one that
// actually reaches us from a parsed URL. Returns a dotted-quad string, or null if `tail` isn't a
// recognizable embedded IPv4.
function embeddedV4(tail) {
  const dotted = tail.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Is `ip` a NON-public address — loopback / link-local / private / ULA / CGNAT / unspecified —
 * i.e. an SSRF target the service must refuse? Covers IPv4, IPv6, and IPv4-mapped IPv6. Anything
 * that isn't a recognizable IP literal is treated as blocked (fail closed).
 */
export function isBlockedIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const o = String(ip).split(".").map(Number);
    return (
      o[0] === 0 ||                                   // 0.0.0.0/8   unspecified / "this host"
      o[0] === 10 ||                                  // 10.0.0.0/8  private
      o[0] === 127 ||                                 // 127.0.0.0/8 loopback
      (o[0] === 169 && o[1] === 254) ||               // 169.254.0.0/16 link-local (cloud metadata)
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||   // 172.16.0.0/12 private
      (o[0] === 192 && o[1] === 168) ||               // 192.168.0.0/16 private
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127)     // 100.64.0.0/10 CGNAT
    );
  }
  if (v === 6) {
    const a = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true;       // unspecified / loopback
    if (/^fe[89ab]/.test(a)) return true;             // fe80::/10 link-local (fe80–febf)
    if (a.startsWith("fc") || a.startsWith("fd")) return true; // fc00::/7 ULA
    // IPv4-mapped ::ffff:0:0/96 — decode the embedded v4 in dotted OR hex spelling and range-check
    // it. Anchored to `^::ffff:` so a legit global address that merely contains an "ffff" group
    // isn't over-blocked. Mapped-but-undecodable fails closed.
    const mapped = a.match(/^::ffff:(.+)$/);
    if (mapped) { const v4 = embeddedV4(mapped[1]); return v4 ? isBlockedIp(v4) : true; }
    // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 in its low 32 bits; on a NAT64-capable
    // network it routes to that v4, so decode + range-check it too (defense in depth).
    const nat64 = a.match(/^64:ff9b::(.+)$/);
    if (nat64) { const v4 = embeddedV4(nat64[1]); if (v4) return isBlockedIp(v4); }
    // IPv4-compatible ::/96 (deprecated): ::a.b.c.d or ::x:y — decode + range-check the embedded v4.
    const compat = a.match(/^::(.+)$/);
    if (compat) { const v4 = embeddedV4(compat[1]); if (v4) return isBlockedIp(v4); }
    return false;
  }
  return true; // not an IP literal → fail closed
}

/**
 * Validate that a user-supplied URL is safe to fetch server-side, and return the validated IP to
 * pin Chrome to. Throws on a non-http(s) scheme, a blocked/internal hostname, an unresolvable host,
 * or ANY resolved address that isn't public. `resolve` is injectable for deterministic tests
 * (defaults to DNS). A literal-IP host skips DNS and is range-checked directly.
 * @returns {Promise<string>} the validated IP to pin
 */
export async function assertPublicUrl(url, { resolve = lookup } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error(`theme URL must be a valid http(s) URL: ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`theme URL must be http or https, not ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`refusing to grab a non-public host (SSRF guard): ${host}`);
  }
  let addrs;
  if (isIP(host)) {
    addrs = [{ address: host }];                      // literal IP — no DNS needed
  } else {
    try { addrs = await resolve(host, { all: true }); }
    catch { throw new Error(`could not resolve theme URL host: ${host}`); }
    if (!addrs || !addrs.length) throw new Error(`theme URL host did not resolve: ${host}`);
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`refusing to grab a non-public address ${address} for ${host} (SSRF guard)`);
  }
  return addrs[0].address;
}

/**
 * Walk the MAIN-document redirect chain Node-side BEFORE any render, re-validating each hop through
 * assertPublicUrl so a 302 from a public host to a private/metadata host can't smuggle Chrome onto
 * an internal target (issue #21). Starting from `url`, issue `fetchImpl(current, { method: 'GET',
 * redirect: 'manual' })`; while the response is a 3xx with a `Location` header, resolve `Location`
 * against the current URL (`new URL(loc, current)`), validate that absolute URL (which also yields
 * the pinned IP for THAT hop), and continue — up to `maxHops`. Returns `{ finalUrl, pinnedIp }` for
 * the first non-redirect response, where `pinnedIp` is the validated IP of `finalUrl`'s host.
 *
 * Throws if a hop fails assertPublicUrl (private/metadata redirect target), if a 3xx has no/invalid
 * `Location`, or if the chain exceeds `maxHops` (loop / over-long). `fetchImpl` and `validate` are
 * injectable so tests are deterministic with NO real network/DNS.
 * @returns {Promise<{finalUrl:string, pinnedIp:string}>}
 */
export async function resolveRedirectChain(url, { fetchImpl = fetch, maxHops = 5, validate = assertPublicUrl } = {}) {
  let current = String(url);
  let pinnedIp = await validate(current);          // validate + pin the INITIAL host
  for (let hop = 0; hop <= maxHops; hop++) {
    // 10s timeout so a slow/hanging redirect server can't hang the grab; cancel the body on every
    // response (we never read it) to release the socket and avoid connection-pool exhaustion.
    const res = await fetchImpl(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10000) });
    const status = res?.status;
    const isRedirect = typeof status === "number" && status >= 300 && status < 400;
    if (res?.body?.cancel) await res.body.cancel().catch(() => {});
    if (!isRedirect) {
      // First non-redirect response (2xx / other) — render THIS url, pinned to its validated IP.
      return { finalUrl: current, pinnedIp };
    }
    const loc = res.headers?.get ? res.headers.get("location") : undefined;
    if (!loc) throw new Error(`redirect (${status}) with no Location header from ${current} (SSRF guard)`);
    let next;
    try { next = new URL(loc, current).toString(); }
    catch { throw new Error(`redirect (${status}) with invalid Location "${loc}" from ${current} (SSRF guard)`); }
    // Re-validate EVERY redirect target — a private/metadata host throws here — and re-pin to it.
    pinnedIp = await validate(next);
    current = next;
  }
  throw new Error(`theme URL exceeded ${maxHops} redirects (possible loop) starting from ${url} (SSRF guard)`);
}

/**
 * Playwright URL renderer (the default, ADR-0024): drive a real headless Chromium so JS-heavy /
 * anti-bot pages (e.g. https://500designs.com) are fully PAINTED before we capture. Unlike the raw
 * `chrome --print-to-pdf` path (chromeUrlRenderer), this:
 *   - waits for `networkidle` and then a short settle delay so late-hydrating React/SPA content and
 *     webfonts have a frame to lay out (the actual fix for "the grabbed PDF is half-rendered");
 *   - retries transient navigation failures (anti-bot 403, flaky net) up to `maxRetries`;
 *   - uses a realistic desktop viewport + UA so trivially-fingerprinted pages render normally.
 *
 * We use the `playwright` the service ALREADY ships (demo.js drives it the same way) — no extra
 * dependency. crawlee was evaluated and rejected: it's a multi-page crawling framework (~40–75 MB,
 * 14 sub-packages) and we'd use one class for one `page.pdf()` call; everything needed here is a
 * `page.goto(networkidle)` + settle + retry on plain Playwright.
 *
 * The SSRF posture is UNCHANGED — grabUrlToPdf already walked + re-validated the whole redirect
 * chain Node-side and passes us the FINAL url + its validated IP. We keep the anti-DNS-rebinding pin
 * by mapping host→pinnedIp via Chromium's `--host-resolver-rules` launch arg (same mechanism
 * chromeUrlRenderer used), and navigate to exactly finalUrl (no in-browser redirect following).
 *
 * playwright is loaded lazily (dynamic import) so the service still boots and the OTHER code paths
 * run even if its browser binaries are absent; only an actual URL grab needs it, mirroring demo.js.
 * @returns {Promise<{path:string}>}
 */
export async function playwrightUrlRenderer(url, pdfPath, opts = {}) {
  const {
    pinnedIp,
    headless = true,
    settleMs = 1500,              // extra paint time after networkidle for late-hydrating SPAs
    navigationTimeoutMs = 45000,
    maxRetries = 2,               // retry transient nav failures (anti-bot 403, flaky net)
    importPlaywright = () => import("playwright"),
  } = opts;

  let chromium;
  try {
    ({ chromium } = await importPlaywright());
  } catch {
    throw new Error("Playwright is not installed — run `npx playwright install` (the install gate should have caught this)");
  }

  // Pin the validated IP into Chromium so the address it connects to is exactly the one the SSRF
  // guard approved (anti-DNS-rebinding) — same `--host-resolver-rules` trick chromeUrlRenderer used.
  const launchArgs = ["--disable-gpu", "--no-sandbox"];
  if (pinnedIp) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    launchArgs.push(`--host-resolver-rules=MAP ${host} ${pinnedIp}`);
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let browser = null;
    try {
      browser = await chromium.launch({ headless, args: launchArgs });
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 1600 },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US",
      });
      const page = await ctx.newPage();
      // networkidle: wait until the page has actually fetched + run its bundle before we snapshot it.
      await page.goto(url, { waitUntil: "networkidle", timeout: navigationTimeoutMs });
      await page.waitForTimeout(settleMs);            // late hydration / webfonts get a frame to paint
      await page.emulateMedia({ media: "screen" });   // capture the SCREEN design, not @media print
      await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: false });
      if (existsSync(pdfPath)) return { path: pdfPath };
      lastErr = new Error("no PDF produced");
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    } finally {
      if (browser) await browser.close().catch(() => {});  // never leave a Chromium bound after a grab
    }
  }
  throw new Error(`Playwright URL render failed: ${String(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 300)}`);
}

/**
 * Legacy/fallback URL renderer: ASYNC headless Chrome `--print-to-pdf` over a live https URL. Uses
 * `spawn` (not spawnSync) so a multi-second render never blocks the Node event loop / SSE
 * heartbeats. When `pinnedIp` is given, the host is pinned to it via --host-resolver-rules so the
 * address Chrome connects to is exactly the one assertPublicUrl validated (anti-DNS-rebinding). A
 * missing Chrome degrades to the same clear "set WI_CHROME" error as PDF export. Kept as an
 * injectable fallback for environments without Playwright browsers; it does NOT wait for
 * networkidle, so JS-heavy pages may capture under-rendered (the reason playwrightUrlRenderer is
 * now the default).
 * @returns {Promise<{path:string}>}
 */
export function chromeUrlRenderer(url, pdfPath, opts = {}) {
  const { chromePath, noHeaderFooter = true, args = [], pinnedIp, findChrome = defaultFindChrome } = opts;
  const chrome = findChrome(chromePath);
  if (!chrome) throw new Error("no Chrome/Chromium found for URL render (set WI_CHROME)");
  const flags = ["--headless=new", "--disable-gpu", "--no-sandbox"];
  if (noHeaderFooter) flags.push("--no-pdf-header-footer");
  if (pinnedIp) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    flags.push(`--host-resolver-rules=MAP ${host} ${pinnedIp}`);
  }
  flags.push(...args, `--print-to-pdf=${pdfPath}`, url);
  return new Promise((resolveP, reject) => {
    // ignore stdout (unread + full → deadlock); pipe stderr only; guard the stderr stream.
    const child = spawn(chrome, flags, { timeout: 60000, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d; });
    child.stderr?.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0 || !existsSync(pdfPath)) {
        reject(new Error(`chrome URL render failed (${signal ? `signal ${signal}` : `status ${code}`}): ${stderr.slice(0, 300)}`));
      } else {
        resolveP({ path: pdfPath });
      }
    });
  });
}

/**
 * Grab a live URL to a PDF at `outPath`. SSRF-guards the URL BEFORE rendering anything: instead of
 * validating only the initial URL, it walks the MAIN-document redirect chain Node-side
 * (resolveRedirectChain), re-validating EVERY hop, so a 302 to a private/metadata host can't smuggle
 * the browser onto an internal target (issue #21). It then renders the FINAL url, pinned to the
 * FINAL host's validated IP. Async — awaits the render so it never blocks the loop.
 *
 * The default `renderer` is now `playwrightUrlRenderer` (ADR-0024): plain Playwright (already shipped)
 * drives a real Chromium and WAITS for networkidle + a settle delay so JS-heavy pages are fully
 * painted before capture (the old raw `chrome --print-to-pdf` path didn't wait and produced
 * half-rendered SPAs). `chromeUrlRenderer` remains exported as a no-browser-deps fallback. `renderer`,
 * `validate`, and `fetchImpl` are injectable for tests (the suite injects a fake renderer, so no
 * browser runs).
 * @returns {Promise<{path:string}>}
 */
export async function grabUrlToPdf(url, outPath, { renderer = playwrightUrlRenderer, chromePath, renderOpts = {}, validate = assertPublicUrl, fetchImpl = fetch } = {}) {
  const { finalUrl, pinnedIp } = await resolveRedirectChain(url, { fetchImpl, validate });
  await renderer(finalUrl, outPath, { chromePath, pinnedIp, ...renderOpts });
  return { path: outPath };
}
