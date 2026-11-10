// loopback-bind.test.js — the bridge listens on loopback only (wicked-interactive#344).
//
// It used to `listen(port)` with no host, which binds every interface: documents and the bridge
// API were reachable from the local network. It must bind 127.0.0.1 (and ::1 when the host has
// IPv6, so a client resolving `localhost` to ::1 still connects) and nothing else.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { connect, createServer as netServer } from "node:net";
import { createMultiServer, createServer } from "../src/service/server.js";
import { isPortFree } from "../src/service/serve-bridge.mjs";
import { listenLoopback, isLoopbackAddress, LOOPBACK_HOSTS } from "../src/service/loopback.js";

const busDir = mkdtempSync(join(tmpdir(), "wi-bus-loopback-"));
process.env.WICKED_BUS_DATA_DIR = busDir;

const recorder = {
  status: async () => ({ ok: true, browser: "x", missing: [], components: [], playwright_version: "x", install_command: "x", remedy: "x" }),
  install: async () => {},
  autoInstall: false,
};

/** This host's non-loopback addresses, by family (link-local IPv6 needs a scope; skip it). */
function externalAddresses() {
  const v4 = [], v6 = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || isLoopbackAddress(a.address)) continue;
      if (a.family === "IPv4" || a.family === 4) v4.push(a.address);
      else if (!a.address.toLowerCase().startsWith("fe80")) v6.push(a.address);
    }
  }
  return { v4, v6 };
}

/** Resolves "connected" or the error code; never hangs past timeoutMs. */
function tryConnect(host, port, timeoutMs = 1500) {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (v) => { clearTimeout(timer); sock.destroy(); res(v); };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    sock.once("connect", () => done("connected"));
    sock.once("error", (e) => done(e.code || "error"));
  });
}

async function hasIpv6Loopback() {
  try {
    const s = netServer();
    await new Promise((res, rej) => { s.once("error", rej); s.listen(0, "::1", res); });
    await new Promise((r) => s.close(r));
    return true;
  } catch { return false; }
}

let root, multi, multiPort, single, singleDir, singlePort, ipv6;

before(async () => {
  ipv6 = await hasIpv6Loopback();
  root = mkdtempSync(join(tmpdir(), "wi-loopback-"));
  multi = createMultiServer({ root, recorder });
  multiPort = await multi.start(0);
  singleDir = mkdtempSync(join(tmpdir(), "wi-loopback-doc-"));
  single = createServer({ dir: singleDir, documentId: "doc", recorder });
  singlePort = await single.start(0);
});

after(async () => {
  await multi?.stop();
  await single?.stop();
  for (const d of [root, singleDir, busDir]) if (d) rmSync(d, { recursive: true, force: true });
});

for (const [label, get] of [["multi-doc bridge", () => [multi, multiPort]], ["single-doc server", () => [single, singlePort]]]) {
  test(`${label}: every listening address is loopback (127.0.0.1 or ::1)`, () => {
    const [svc, port] = get();
    const addrs = svc.addresses();
    assert.ok(addrs.length >= 1, "at least one listener");
    for (const a of addrs) {
      assert.ok(a.address === "127.0.0.1" || a.address === "::1", `listening on ${a.address}, which is not loopback`);
      assert.equal(a.port, port, "every listener shares the reported port");
    }
    assert.ok(addrs.some((a) => a.address === "127.0.0.1"), "IPv4 loopback is always bound");
    if (ipv6) assert.ok(addrs.some((a) => a.address === "::1"), "::1 is bound when the host has IPv6 loopback");
  });

  test(`${label}: not reachable on a non-loopback interface address`, async (t) => {
    const [, port] = get();
    const { v4, v6 } = externalAddresses();
    if (!v4.length) {
      t.skip("host has no non-loopback IPv4 address; reachability on an external interface not checked");
      return;
    }
    for (const host of [...v4, ...v6]) {
      const r = await tryConnect(host, port);
      assert.notEqual(r, "connected", `bridge port ${port} accepted a connection on ${host}`);
    }
  });
}

test("multi-doc bridge answers over every loopback name a client uses", async () => {
  for (const host of ["127.0.0.1", "localhost", ...(ipv6 ? ["[::1]"] : [])]) {
    const r = await fetch(`http://${host}:${multiPort}/api/health`);
    assert.equal(r.status, 200, `GET via ${host}`);
    assert.equal((await r.json()).port, multiPort, "health reports the listening port");
  }
});

test("isPortFree: a port held on either loopback address is not free", async () => {
  for (const host of ipv6 ? LOOPBACK_HOSTS : ["127.0.0.1"]) {
    const s = netServer();
    const port = await new Promise((res) => s.listen(0, host, () => res(s.address().port)));
    try { assert.equal(await isPortFree(port), false, `held on ${host}`); }
    finally { await new Promise((r) => s.close(r)); }
  }
});

test("listenLoopback: an explicit taken port rejects EADDRINUSE and leaves nothing bound", async () => {
  const held = await listenLoopback(() => netServer(), 0);
  try {
    await assert.rejects(listenLoopback(() => netServer(), held.port), (e) => e.code === "EADDRINUSE");
  } finally { await held.close(); }
  assert.equal(await isPortFree(held.port), true, "released after close");
});

test("start() refuses a listen-options object: the host is never the caller's to choose", async () => {
  for (const svc of [createMultiServer({ root: mkdtempSync(join(tmpdir(), "wi-loopback-opt-")), recorder }), createServer({ dir: mkdtempSync(join(tmpdir(), "wi-loopback-opt-doc-")), recorder })]) {
    for (const bad of [{ port: 0, host: "0.0.0.0" }, { port: 0, host: "::" }, { port: 0, host: "::ffff:127.0.0.1" }, { port: 0 }, "0", -1, 65536, 1.5]) {
      await assert.rejects(svc.start(bad), TypeError, `start(${JSON.stringify(bad)})`);
      assert.deepEqual(svc.addresses(), [], "nothing bound");
    }
    await svc.stop();
  }
});

test("an explicit port another process holds on the wildcard is EADDRINUSE, not shadowed on loopback", async () => {
  // macOS/BSD would let a loopback bind succeed over a foreign wildcard listener (SO_REUSEADDR);
  // the bridge must refuse it the way a plain listen(port) used to, so the CLI falls forward.
  for (const wildcard of ["0.0.0.0", ...(ipv6 ? ["::"] : [])]) {
    const other = netServer();
    const port = await new Promise((res) => other.listen(0, wildcard, () => res(other.address().port)));
    try {
      await assert.rejects(listenLoopback(() => netServer(), port), (e) => e.code === "EADDRINUSE", `held on ${wildcard}`);
      assert.equal(await isPortFree(port), false, `isPortFree with ${wildcard} held`);
    } finally { await new Promise((r) => other.close(r)); }
  }
});

test("isLoopbackAddress accepts 127/8 and ::1 only", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["0.0.0.0", "::", "::ffff:127.0.0.1", "10.0.0.1", "192.168.1.2", "", undefined]) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});
