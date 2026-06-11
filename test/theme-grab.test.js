// theme-grab.test.js — the DETERMINISTIC grab→PDF primitive + the SSRF guard (ADR-0010/ADR-0020).
// Injectable renderer + validator so CI needs no real browser, network, or DNS. We do NOT test the
// vision synthesis of a theme — that is an agent skill step (Step 8.5), not service code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grabUrlToPdf, chromeUrlRenderer, assertPublicUrl, isBlockedIp } from "../src/service/theme-grab.js";

process.env.WICKED_NO_BUS = "1";

function tmp() { return mkdtempSync(join(tmpdir(), "wi-theme-")); }

// Validator stub: approves any URL and pins a public IP — keeps the grab tests off DNS/network.
// The guard itself is covered by the assertPublicUrl / isBlockedIp tests below.
const approve = async () => "93.184.216.34";

test("grabUrlToPdf delegates to the renderer with the LIVE url + pinned IP and writes a PDF", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    let seenUrl = null, seenPath = null, seenOpts = null;
    const fakeRenderer = (url, pdfPath, opts) => {
      seenUrl = url; seenPath = pdfPath; seenOpts = opts;
      mkdirSync(dir, { recursive: true });
      writeFileSync(pdfPath, "%PDF-1.4 fake");
      return { path: pdfPath };
    };
    const { path } = await grabUrlToPdf("https://example.com/pricing", out, { renderer: fakeRenderer, validate: approve });
    assert.equal(path, out, "returns the requested out path");
    assert.ok(existsSync(path), "a PDF file was written");
    assert.match(readFileSync(path, "utf-8"), /^%PDF/);
    // The renderer must receive the LIVE https URL, NOT a file:// path.
    assert.equal(seenUrl, "https://example.com/pricing");
    assert.doesNotMatch(seenUrl, /^file:\/\//);
    assert.equal(seenPath, out);
    assert.equal(seenOpts.pinnedIp, "93.184.216.34", "the validated IP is pinned into the render (anti-rebind)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("grabUrlToPdf rejects a non-http(s) url before spawning (no DNS)", async () => {
  let calls = 0;
  const fakeRenderer = () => { calls++; };
  await assert.rejects(grabUrlToPdf("ftp://internal/secret", "/tmp/x.pdf", { renderer: fakeRenderer }), /http or https/);
  await assert.rejects(grabUrlToPdf("not a url at all", "/tmp/x.pdf", { renderer: fakeRenderer }), /valid http\(s\) URL/);
  assert.equal(calls, 0, "the renderer is never invoked for an invalid url");
});

test("chromeUrlRenderer throws a clear 'set WI_CHROME' error when no Chrome is found", () => {
  // The no-Chrome guard throws synchronously, before the render Promise is constructed.
  assert.throws(
    () => chromeUrlRenderer("https://example.com", "/tmp/nope.pdf", { findChrome: () => null }),
    /no Chrome\/Chromium found.*WI_CHROME/,
  );
});

// --- SSRF guard (security review) ---

test("isBlockedIp blocks loopback / link-local / private / ULA / CGNAT / unspecified; allows public", () => {
  for (const bad of ["127.0.0.1", "10.0.0.1", "172.16.5.9", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "feb0::1", "fc00::1",
    "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
    // IPv4-mapped in HEX spelling — the form the WHATWG URL parser actually produces (the bypass
    // an earlier cut missed): ::ffff:a9fe:a9fe == 169.254.169.254, ::ffff:7f00:1 == 127.0.0.1, etc.
    "::ffff:a9fe:a9fe", "::ffff:7f00:1", "::ffff:0a00:0001", "::ffff:c0a8:0101",
    "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1",  // NAT64 well-known prefix embedding metadata/loopback
    "::a9fe:a9fe"]) {  // IPv4-compatible ::/96 (deprecated) embedding link-local
    assert.equal(isBlockedIp(bad), true, `${bad} must be blocked`);
  }
  for (const ok of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111",
    "2001:db8:ffff::1", "::ffff:808:808" /* mapped public 8.8.8.8 */]) {
    assert.equal(isBlockedIp(ok), false, `${ok} must be allowed`);
  }
  assert.equal(isBlockedIp("not-an-ip"), true, "a non-IP literal fails closed");
});

test("assertPublicUrl rejects metadata/loopback/internal hostnames and non-http(s) (no DNS)", async () => {
  await assert.rejects(assertPublicUrl("http://localhost/x"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://metadata.google.internal/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://foo.internal/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://printer.local/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("ftp://example.com/"), /http or https/);
});

test("assertPublicUrl range-checks a literal-IP host without DNS and pins a public one", async () => {
  await assert.rejects(assertPublicUrl("http://127.0.0.1:9000/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://10.0.0.5/"), /SSRF guard/);
  // The IPv4-mapped IPv6 bypass: the URL parser normalizes this to hex (::ffff:a9fe:a9fe), which
  // must still be decoded and blocked — otherwise it's a direct path to the cloud metadata IP.
  await assert.rejects(assertPublicUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"), /SSRF guard/);
  await assert.rejects(assertPublicUrl("http://[::1]/"), /SSRF guard/);
  assert.equal(await assertPublicUrl("http://8.8.8.8/"), "8.8.8.8", "a literal public IP is allowed + pinned");
});

test("assertPublicUrl rejects a host that RESOLVES to a private address (DNS-rebind path)", async () => {
  const resolvePrivate = async () => [{ address: "169.254.169.254" }];
  await assert.rejects(assertPublicUrl("https://evil.example.com/", { resolve: resolvePrivate }), /non-public address/);
  // ALL resolved addresses must be public — one private in the set is enough to reject.
  const resolveMixed = async () => [{ address: "93.184.216.34" }, { address: "10.1.2.3" }];
  await assert.rejects(assertPublicUrl("https://evil.example.com/", { resolve: resolveMixed }), /non-public address/);
  // all public -> returns the first (the IP to pin).
  const resolvePublic = async () => [{ address: "93.184.216.34" }];
  assert.equal(await assertPublicUrl("https://good.example.com/", { resolve: resolvePublic }), "93.184.216.34");
});
