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
// closes the direct (paste-the-metadata-URL) and DNS-rebinding vectors. RESIDUAL: an HTTP redirect
// from a public host to a private one is followed by Chrome and is NOT closed by the host pin — the
// complete mitigation is network-egress restriction (a namespace/firewall limiting Chrome to public
// CIDRs); tracked as a follow-up. The renderer + validator are injectable so CI needs no
// browser/network and the guard is unit-testable deterministically.

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
 * Default URL renderer: ASYNC headless Chrome `--print-to-pdf` over a live https URL. Uses `spawn`
 * (not spawnSync) so a multi-second render never blocks the Node event loop / SSE heartbeats.
 * When `pinnedIp` is given, the host is pinned to it via --host-resolver-rules so the address
 * Chrome connects to is exactly the one assertPublicUrl validated (anti-DNS-rebinding). A missing
 * Chrome degrades to the same clear "set WI_CHROME" error as PDF export.
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
    const child = spawn(chrome, flags, { timeout: 60000 });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d; });
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
 * Grab a live URL to a PDF at `outPath`. SSRF-guards the URL (assertPublicUrl) BEFORE spawning
 * anything, pins Chrome to the validated IP, then delegates to the injectable `renderer`. Async —
 * awaits the render so it never blocks the loop. `validate` + `renderer` are injectable for tests.
 * @returns {Promise<{path:string}>}
 */
export async function grabUrlToPdf(url, outPath, { renderer = chromeUrlRenderer, chromePath, renderOpts = {}, validate = assertPublicUrl } = {}) {
  const pinnedIp = await validate(url);
  await renderer(url, outPath, { chromePath, pinnedIp, ...renderOpts });
  return { path: outPath };
}
