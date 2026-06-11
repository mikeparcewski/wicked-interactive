// theme-grab.test.js — the DETERMINISTIC grab→PDF primitive + the SSRF guard (ADR-0010/ADR-0020).
// Injectable renderer + validator so CI needs no real browser, network, or DNS. We do NOT test the
// vision synthesis of a theme — that is an agent skill step (Step 8.5), not service code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grabUrlToPdf, chromeUrlRenderer, playwrightUrlRenderer, assertPublicUrl, isBlockedIp, resolveRedirectChain } from "../src/service/theme-grab.js";

process.env.WICKED_NO_BUS = "1";

function tmp() { return mkdtempSync(join(tmpdir(), "wi-theme-")); }

// Validator stub: approves any URL and pins a public IP — keeps the grab tests off DNS/network.
// The guard itself is covered by the assertPublicUrl / isBlockedIp tests below.
const approve = async () => "93.184.216.34";

// Minimal Response-shape stub for the injected fetchImpl — status + a get('location') header.
function fakeResponse(status, location) {
  return { status, headers: { get: (k) => (k.toLowerCase() === "location" ? (location ?? null) : null) } };
}
// fetchImpl that always returns a final (non-redirect) 200 — keeps the grab tests off the network.
const fetch200 = async () => fakeResponse(200);

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
    const { path } = await grabUrlToPdf("https://example.com/pricing", out, { renderer: fakeRenderer, validate: approve, fetchImpl: fetch200 });
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

test("grabUrlToPdf rejects a non-http(s) url before spawning (no DNS, no fetch)", async () => {
  let calls = 0, fetches = 0;
  const fakeRenderer = () => { calls++; };
  const noFetch = async () => { fetches++; return fakeResponse(200); };
  await assert.rejects(grabUrlToPdf("ftp://internal/secret", "/tmp/x.pdf", { renderer: fakeRenderer, fetchImpl: noFetch }), /http or https/);
  await assert.rejects(grabUrlToPdf("not a url at all", "/tmp/x.pdf", { renderer: fakeRenderer, fetchImpl: noFetch }), /valid http\(s\) URL/);
  assert.equal(calls, 0, "the renderer is never invoked for an invalid url");
  assert.equal(fetches, 0, "fetch is never invoked — initial-host validation fails first");
});

// --- playwright renderer (ADR-0024): the default. We inject `importPlaywright` with a fake
// chromium so the wiring (networkidle wait, IP pin, settle, retry, page.pdf, browser teardown) is
// covered with NO real browser or network. crawlee was evaluated and rejected (40–75 MB for one
// page.pdf() call); we use the plain `playwright` the service already ships. ---

// Build a fake `playwright` import: chromium.launch → browser → newContext → newPage, recording
// every call. `failTimes` makes the first N goto() calls throw (to exercise the retry loop).
function fakePlaywrightImport({ pdfBytes = "%PDF-1.4 pw", failTimes = 0 } = {}) {
  const captured = { launchArgs: null, contextOpts: null, gotoArgs: [], pageCalls: [], closed: 0, attempts: 0 };
  let failsLeft = failTimes;
  const chromium = {
    launch: async ({ headless, args }) => {
      captured.launchArgs = args;
      return {
        newContext: async (opts) => {
          captured.contextOpts = opts;
          return {
            newPage: async () => ({
              goto: async (url, o) => {
                captured.attempts++; captured.gotoArgs.push([url, o]);
                if (failsLeft > 0) { failsLeft--; throw new Error("nav timeout (anti-bot 403)"); }
              },
              waitForTimeout: async (ms) => captured.pageCalls.push(["waitForTimeout", ms]),
              emulateMedia: async (o) => captured.pageCalls.push(["emulateMedia", o]),
              pdf: async (o) => { captured.pageCalls.push(["pdf", o]); mkdirSync(join(o.path, ".."), { recursive: true }); writeFileSync(o.path, pdfBytes); },
            }),
          };
        },
        close: async () => { captured.closed++; },
      };
    },
  };
  return { import: async () => ({ chromium }), captured };
}

test("playwrightUrlRenderer waits for networkidle, pins the IP, settles, and writes a PDF", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    const { import: importPlaywright, captured } = fakePlaywrightImport();
    const res = await playwrightUrlRenderer("https://500designs.com/", out, {
      pinnedIp: "93.184.216.34", settleMs: 10, importPlaywright,
    });
    assert.equal(res.path, out);
    assert.ok(existsSync(out), "the playwright renderer produced a PDF");
    assert.equal(captured.gotoArgs[0][0], "https://500designs.com/", "navigated to exactly the final URL");
    assert.equal(captured.gotoArgs[0][1].waitUntil, "networkidle", "waits for networkidle so JS-heavy pages paint");
    // IP pin survives into Chromium launch args (anti-DNS-rebinding preserved).
    assert.ok(captured.launchArgs.some((a) => a === "--host-resolver-rules=MAP 500designs.com 93.184.216.34"),
      "pins host→validated IP via --host-resolver-rules");
    assert.ok(captured.pageCalls.some(([m, o]) => m === "pdf" && o.printBackground === true), "prints with backgrounds on");
    assert.ok(captured.pageCalls.some(([m]) => m === "waitForTimeout"), "gives late hydration a settle frame");
    assert.equal(captured.closed, 1, "closes the browser so none is left running");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("playwrightUrlRenderer retries a transient nav failure, then succeeds", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    const { import: importPlaywright, captured } = fakePlaywrightImport({ failTimes: 1 });
    const res = await playwrightUrlRenderer("https://anti-bot.example.com/", out, { settleMs: 1, maxRetries: 2, importPlaywright });
    assert.equal(res.path, out);
    assert.ok(existsSync(out), "produced a PDF after a retry");
    assert.equal(captured.attempts, 2, "retried once (first goto threw) then succeeded");
    assert.equal(captured.closed, 2, "each attempt's browser is closed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("playwrightUrlRenderer surfaces a render failure after retries (no silent empty PDF)", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    const { import: importPlaywright } = fakePlaywrightImport({ failTimes: 99 });
    await assert.rejects(
      playwrightUrlRenderer("https://anti-bot.example.com/", out, { settleMs: 1, maxRetries: 1, importPlaywright }),
      /Playwright URL render failed/,
    );
    assert.ok(!existsSync(out), "no PDF artifact on failure");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("playwrightUrlRenderer throws a clear 'Playwright is not installed' error when the import fails", async () => {
  const importPlaywright = async () => { throw new Error("Cannot find package 'playwright'"); };
  await assert.rejects(
    playwrightUrlRenderer("https://example.com/", "/tmp/nope.pdf", { importPlaywright }),
    /Playwright is not installed/,
  );
});

test("grabUrlToPdf uses the playwright renderer by default and wires through the final url + pin", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    const { import: importPlaywright, captured } = fakePlaywrightImport();
    // Inject ONLY the playwright import (via renderOpts) — let grabUrlToPdf pick its DEFAULT renderer.
    await grabUrlToPdf("https://example.com/pricing", out, {
      validate: approve, fetchImpl: fetch200, renderOpts: { settleMs: 5, importPlaywright },
    });
    assert.ok(existsSync(out), "default (playwright) renderer produced a PDF");
    assert.equal(captured.gotoArgs[0][0], "https://example.com/pricing", "rendered the validated final URL");
    assert.ok(captured.launchArgs.some((a) => a.includes("MAP example.com 93.184.216.34")), "the validated pin reached the default renderer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// --- redirect-chain preflight (issue #21): Chrome follows main-document redirects, so a 302 from a
// validated public host to a private one was rendered. We walk + re-validate the chain Node-side. ---

test("resolveRedirectChain REJECTS a 302 whose Location is a private/metadata host (the #21 vector)", async () => {
  // Use the REAL validator (assertPublicUrl) with literal-IP / blocked-host targets so no DNS runs.
  for (const evil of ["http://169.254.169.254/", "http://10.0.0.5/internal", "http://localhost:8080/admin"]) {
    let hops = 0;
    const fetchImpl = async (current) => {
      hops++;
      // Initial public host 302s to the attacker-chosen internal Location.
      if (current === "https://public.example.com/") return fakeResponse(302, evil);
      throw new Error(`fetchImpl should never reach the internal target ${current}`);
    };
    // public.example.com is a name → would need DNS; inject a validate that pins it but defers to
    // the REAL guard for the redirect target so the private/metadata hop is what actually throws.
    const validate = async (u) => {
      if (u === "https://public.example.com/") return "93.184.216.34";
      return assertPublicUrl(u); // the evil hop is a literal IP / blocked host → throws (no DNS)
    };
    await assert.rejects(
      resolveRedirectChain("https://public.example.com/", { fetchImpl, validate }),
      /SSRF guard/,
      `redirect to ${evil} must be rejected`,
    );
    assert.equal(hops, 1, "we fetch the initial host once, then reject the redirect BEFORE fetching it");
  }
});

test("resolveRedirectChain resolves a public 302→302→200 chain to the FINAL url + its pinned IP", async () => {
  const pins = { "https://a.example.com/": "1.1.1.1", "https://b.example.com/next": "2.2.2.2", "https://c.example.com/final": "3.3.3.3" };
  const validate = async (u) => pins[u] ?? (() => { throw new Error(`unexpected hop ${u}`); })();
  const fetchImpl = async (current) => {
    if (current === "https://a.example.com/") return fakeResponse(302, "https://b.example.com/next");
    if (current === "https://b.example.com/next") return fakeResponse(301, "https://c.example.com/final");
    if (current === "https://c.example.com/final") return fakeResponse(200);
    throw new Error(`unexpected fetch ${current}`);
  };
  const { finalUrl, pinnedIp } = await resolveRedirectChain("https://a.example.com/", { fetchImpl, validate });
  assert.equal(finalUrl, "https://c.example.com/final", "renders the final public URL");
  assert.equal(pinnedIp, "3.3.3.3", "pins the FINAL host's validated IP, not the initial one");
});

test("resolveRedirectChain throws on a redirect loop / exceeding maxHops", async () => {
  // A→B→A→B… infinite loop. All hops are 'public' per the stub validator, so only the hop cap stops it.
  const validate = async () => "93.184.216.34";
  const fetchImpl = async (current) =>
    current === "https://a.example.com/" ? fakeResponse(302, "https://b.example.com/") : fakeResponse(302, "https://a.example.com/");
  await assert.rejects(
    resolveRedirectChain("https://a.example.com/", { fetchImpl, validate, maxHops: 5 }),
    /exceeded 5 redirects/,
  );
});

test("resolveRedirectChain resolves a RELATIVE Location against the current URL and validates it", async () => {
  const seen = [];
  const validate = async (u) => { seen.push(u); return "93.184.216.34"; };
  const fetchImpl = async (current) => {
    if (current === "https://shop.example.com/old/page") return fakeResponse(302, "../new/landing"); // relative
    return fakeResponse(200);
  };
  const { finalUrl } = await resolveRedirectChain("https://shop.example.com/old/page", { fetchImpl, validate });
  assert.equal(finalUrl, "https://shop.example.com/new/landing", "relative Location resolved against the current URL");
  assert.deepEqual(seen, ["https://shop.example.com/old/page", "https://shop.example.com/new/landing"],
    "BOTH the initial URL and the resolved relative target were validated");
});

test("resolveRedirectChain throws on a 3xx with no Location header", async () => {
  const validate = async () => "93.184.216.34";
  const fetchImpl = async () => fakeResponse(302, null); // 302 but no Location
  await assert.rejects(
    resolveRedirectChain("https://a.example.com/", { fetchImpl, validate }),
    /no Location header/,
  );
});

test("grabUrlToPdf follows a public redirect and renders the FINAL url pinned to its IP (full wire-through)", async () => {
  const dir = tmp();
  try {
    const out = join(dir, "learned.pdf");
    let seenUrl = null, seenOpts = null;
    const fakeRenderer = (url, pdfPath, opts) => {
      seenUrl = url; seenOpts = opts;
      mkdirSync(dir, { recursive: true });
      writeFileSync(pdfPath, "%PDF-1.4 fake");
      return { path: pdfPath };
    };
    const validate = async (u) => (u === "https://start.example.com/" ? "1.1.1.1" : "9.9.9.9");
    const fetchImpl = async (current) =>
      current === "https://start.example.com/" ? fakeResponse(302, "https://final.example.com/page") : fakeResponse(200);
    await grabUrlToPdf("https://start.example.com/", out, { renderer: fakeRenderer, validate, fetchImpl });
    assert.equal(seenUrl, "https://final.example.com/page", "Chrome is pointed at the FINAL url, not the initial one");
    assert.equal(seenOpts.pinnedIp, "9.9.9.9", "Chrome is pinned to the FINAL host's validated IP");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("grabUrlToPdf REJECTS a redirect to the metadata IP before rendering (issue #21 end-to-end)", async () => {
  let rendered = 0;
  const fakeRenderer = () => { rendered++; };
  const validate = async (u) => (u === "https://public.example.com/" ? "93.184.216.34" : assertPublicUrl(u));
  const fetchImpl = async () => fakeResponse(302, "http://169.254.169.254/latest/meta-data/");
  await assert.rejects(
    grabUrlToPdf("https://public.example.com/", "/tmp/should-not-write.pdf", { renderer: fakeRenderer, validate, fetchImpl }),
    /SSRF guard/,
  );
  assert.equal(rendered, 0, "the renderer is never invoked when a redirect hop fails the guard");
});
