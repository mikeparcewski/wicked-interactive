// serve-bridge.test.js — dynamic port + per-root bridge discovery (ADR-0022).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";

import {
  LOCK_NAME, lockPath, readLock, writeLock, removeLock,
  pidAlive, isPortFree, pickPort, bridgeHealthy, bridgeIdentity,
} from "../src/service/serve-bridge.mjs";

function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), "wi-bridge-"));
  return d;
}
// Bind the wildcard address — same as the real server (server.js top.listen(port)) and the
// address isPortFree() probes — so an occupied port is genuinely detected as taken.
const listen = (srv, port = 0) =>
  new Promise((res) => srv.listen(port, "0.0.0.0", () => res(srv.address().port)));
const close = (srv) => new Promise((res) => srv.close(res));

test("lock roundtrip: write → read → remove (ADR-0022)", () => {
  const root = tmpRoot();
  try {
    assert.equal(readLock(root), null, "no lockfile → null");
    const info = { port: 4411, host: "127.0.0.1", pid: 1234, startedAt: "t", version: "x" };
    assert.equal(writeLock(root, info), true);
    assert.equal(lockPath(root), join(root, LOCK_NAME));
    assert.deepEqual(readLock(root), info);
    removeLock(root);
    assert.equal(readLock(root), null, "after remove → null");
    removeLock(root); // idempotent — no throw when already gone
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readLock tolerates corrupt JSON (returns null, never throws)", () => {
  const root = tmpRoot();
  try {
    writeFileSync(join(root, LOCK_NAME), "{not json");
    assert.equal(readLock(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeLock on an unwritable root returns false (serve still runs)", () => {
  // A path whose parent does not exist can't be written — writeLock must swallow + report false.
  const bogus = join(tmpdir(), "wi-bridge-does-not-exist-" + process.pid, "nested");
  assert.equal(writeLock(bogus, { port: 1 }), false);
  assert.equal(existsSync(join(bogus, LOCK_NAME)), false);
});

test("pidAlive: this process is alive, garbage pids are not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(2147483646), false); // astronomically unlikely to exist
});

test("isPortFree reflects whether a port can be bound", async () => {
  const srv = netServer();
  const port = await listen(srv);
  try {
    assert.equal(await isPortFree(port), false, "bound port is not free");
  } finally { await close(srv); }
  assert.equal(await isPortFree(port), true, "released port is free again");
});

test("pickPort falls forward past a taken port", async () => {
  const srv = netServer();
  const taken = await listen(srv); // OS-assigned, guaranteed bound
  try {
    const chosen = await pickPort(taken);
    assert.notEqual(chosen, taken, "must not return the taken port");
    assert.equal(await isPortFree(chosen), true, "returned port must be bindable");
  } finally { await close(srv); }
});

test("pickPort(null) returns a free port at/above the friendly base", async () => {
  const chosen = await pickPort(null);
  assert.ok(chosen === 0 || chosen >= 4400, "either OS-assign (0) or >= 4400");
  if (chosen) assert.equal(await isPortFree(chosen), true);
});

test("bridgeHealthy: 200 on /api/docs → true; 500 → false; nothing → false", async () => {
  // Healthy bridge stub.
  const ok = httpServer((req, res) => {
    if (req.url === "/api/docs") { res.writeHead(200); res.end("[]"); }
    else { res.writeHead(404); res.end(); }
  });
  const okPort = await listen(ok);
  // Unhealthy stub (500).
  const bad = httpServer((_req, res) => { res.writeHead(500); res.end(); });
  const badPort = await listen(bad);
  try {
    assert.equal(await bridgeHealthy("127.0.0.1", okPort, { timeoutMs: 1500 }), true);
    assert.equal(await bridgeHealthy("127.0.0.1", badPort, { timeoutMs: 1500 }), false);
    assert.equal(await bridgeHealthy("127.0.0.1", 0), false, "port 0 → false");
  } finally { await close(ok); await close(bad); }

  // Nothing listening on a now-free port → false (connection refused, not a hang).
  const free = await pickPort(null);
  assert.equal(await bridgeHealthy("127.0.0.1", free, { timeoutMs: 1500 }), false);
});

test("bridgeIdentity returns the root /api/health reports (identity-aware reuse, ADR-0022)", async () => {
  const ours = httpServer((req, res) => {
    if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, root: "/tmp/wi-A", pid: 1 })); }
    else { res.writeHead(404); res.end(); }
  });
  const oursPort = await listen(ours);
  const noHealth = httpServer((_req, res) => { res.writeHead(404); res.end(); });
  const nhPort = await listen(noHealth);
  try {
    assert.equal(await bridgeIdentity("127.0.0.1", oursPort, { timeoutMs: 1500 }), "/tmp/wi-A");
    assert.equal(await bridgeIdentity("127.0.0.1", nhPort, { timeoutMs: 1500 }), null, "no /api/health → null");
    assert.equal(await bridgeIdentity("127.0.0.1", 0), null, "port 0 → null");
  } finally { await close(ours); await close(noHealth); }

  const free = await pickPort(null);
  assert.equal(await bridgeIdentity("127.0.0.1", free, { timeoutMs: 1500 }), null, "nothing listening → null");
});
