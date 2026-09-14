// bridge-two-roots.test.js — S-L7 two-roots (DES-L7 §7, F-RC1-120 / D-19 R20): two bridges on
// two docs roots sharing ONE bus db hold two cursors each, and a command for a doc under root A
// is materialized by A and REFUSED (loudly, never acked silently) by B.
//
// Before per-root identity both bridges registered the fixed plugin names, wicked-bus keyed one
// cursor per (plugin, filter), and whichever bridge polled first drained the other root's
// commands — finding no such doc under its root it acked them with a bare `return` ("the other
// project's bridge ate my demo"). The bridge handler also fanned the foreign frame to its own
// SSE clients before checking the doc.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-two-roots-"));
const { createMultiServer, bridgeRootId, bridgePluginNames } = await import("../src/service/server.js");
const { busDb } = await import("../src/service/bus-client.js");

// Recorder seams injected per bridge (F-RECON-012): nothing here may probe or download a browser.
// `installs` counts the honest provisioning attempts each bridge's materializer made.
function fakeRecorder() {
  const r = {
    browser: { ok: false, browser: "chromium-headless-shell", missing: ["chromium-headless-shell", "ffmpeg"], components: [], playwright_version: "1.62.1", install_command: "node cli install chromium-headless-shell", remedy: "wicked-interactive doctor --install", browsers_path: null, message: "the recorder's browser is not installed" },
    installs: 0,
    status: async () => r.browser,
    install: async () => { r.installs += 1; throw new Error("no network in the unit suite"); },
    autoInstall: true,
  };
  return r;
}

let rootA, rootB, A, B;   // A/B = { svc, base, recorder }

async function boot(root) {
  const recorder = fakeRecorder();
  const svc = createMultiServer({ root, recorder });
  const port = await svc.start(0);
  return { svc, recorder, base: `http://localhost:${port}` };
}

before(async () => {
  rootA = mkdtempSync(join(tmpdir(), "wi-two-roots-a-"));
  rootB = mkdtempSync(join(tmpdir(), "wi-two-roots-b-"));
  A = await boot(rootA);
  B = await boot(rootB);
});
after(async () => {
  // bus-client memoizes ONE db handle per process; the first stop() closes it (closeBus is
  // idempotent). Stop B then A — a poll A attempts in between fails loudly on stderr, by design.
  await B.svc.stop();
  await A.svc.stop();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  rmSync(process.env.WICKED_BUS_DATA_DIR, { recursive: true, force: true });
});

const jpost = (base, path, body) => fetch(`${base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const health = async (base) => (await fetch(`${base}/api/health`)).json();

// Minimal SSE collector: every parsed frame, plus waitFor(pred).
async function openSse(base) {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const waiters = [];
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = "?", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) ev = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (ev === "ready" || (ev === "?" && !data)) continue;
          let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
          const f = { ev, data: parsed };
          frames.push(f);
          for (const w of waiters.slice()) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
        }
      }
    } catch { /* reader cancelled on close */ }
  })();
  return {
    frames,
    waitFor(pred, timeoutMs = 8000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error("SSE waitFor timeout")); } }, timeoutMs);
      });
    },
    close() { try { reader.cancel(); } catch {} },
  };
}
const forDoc = (doc) => (f) => f.data?.payload?.document_id === doc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("identity: each bridge registers wi-service-*@<h8>, h8 = sha256(realpath(root))[0:8]; the two differ", async () => {
  const hA = await health(A.base);
  const hB = await health(B.base);
  for (const h of [hA, hB]) {
    assert.match(h.plugin.bridge, /^wi-service-bridge@[0-9a-f]{8}$/);
    assert.match(h.plugin.commands, /^wi-service-commands@[0-9a-f]{8}$/);
    assert.equal(typeof h.unknown_doc_refused, "number");
  }
  assert.notEqual(hA.plugin.commands, hB.plugin.commands, "two roots ⇒ two identities");
  const expectA = createHash("sha256").update(realpathSync(rootA)).digest("hex").slice(0, 8);
  assert.equal(bridgeRootId(rootA), expectA);
  assert.deepEqual(hA.plugin, bridgePluginNames(rootA));
  assert.deepEqual(hA.plugin, A.svc.plugin);
  assert.equal(hA.root, rootA, "/api/health.root is untouched (ADR-0022 identity probe)");
  // Deterministic: the same root always derives the same names (a restart resumes ITS cursors).
  assert.deepEqual(bridgePluginNames(rootA), bridgePluginNames(rootA));
});

test("one bus db, two bridges ⇒ two live wi-service-commands@… subscription rows (the ONE check)", () => {
  const rows = busDb().prepare(
    "SELECT plugin FROM subscriptions WHERE deregistered_at IS NULL AND role = 'subscriber' AND plugin LIKE 'wi-service-commands@%'",
  ).all().map((r) => r.plugin).sort();
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.deepEqual(rows, [A.svc.plugin.commands, B.svc.plugin.commands].sort());
  const bridges = busDb().prepare(
    "SELECT plugin FROM subscriptions WHERE deregistered_at IS NULL AND role = 'subscriber' AND plugin LIKE 'wi-service-bridge@%'",
  ).all();
  assert.equal(bridges.length, 2);
});

test("a command for a doc under root A is materialized by A; B refuses it (counter ≥ 1, nothing on B's SSE, no ack-by-silence)", async () => {
  const sseA = await openSse(A.base);
  const sseB = await openSse(B.base);
  try {
    const refusedB0 = (await health(B.base)).unknown_doc_refused;
    assert.equal((await jpost(A.base, "/api/docs", { name: "alpha-doc", html: "<h1>Q2 Results</h1><p>body</p>" })).status, 200);
    await sseA.waitFor((f) => f.ev === "wicked.interactive.doc.created" && forDoc("alpha-doc")(f));

    // A UI command for A's doc, posted through A (whitelist + known doc). Both bridges' command
    // loops receive it from the shared bus; only A owns the doc.
    const r = await jpost(A.base, "/api/events", {
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "alpha-doc", items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }] },
    });
    assert.equal(r.status, 200);
    const vc = await sseA.waitFor((f) => f.ev === "wicked.interactive.version.created" && forDoc("alpha-doc")(f));
    assert.equal(vc.data.payload.version, 1, "A materialized exactly one version");
    await sseA.waitFor((f) => f.ev === "wicked.interactive.feedback.processed" && forDoc("alpha-doc")(f));
    // Let B's pollers see every frame of the exchange (500 ms poll cadence) before judging.
    await sleep(1200);

    const hB = await health(B.base);
    assert.ok(hB.unknown_doc_refused > refusedB0, `B refused A's frames (was ${refusedB0}, now ${hB.unknown_doc_refused})`);
    assert.equal(hB.unknown_doc_refused, B.svc.unknownDocRefused);
    assert.equal((await health(A.base)).unknown_doc_refused, 0, "A owns the doc — nothing to refuse");
    assert.equal(sseB.frames.filter(forDoc("alpha-doc")).length, 0, "the guard sits BEFORE the SSE fan-out (review F6)");
    assert.ok(sseA.frames.filter(forDoc("alpha-doc")).length >= 3, "A's own clients saw the whole exchange");
    // The version really landed under A, and B has no such doc.
    assert.match(await (await fetch(`${A.base}/d/alpha-doc/doc`)).text(), /Q3 Results/);
    assert.equal((await fetch(`${B.base}/d/alpha-doc/doc`)).status, 404);
    assert.deepEqual(await (await fetch(`${B.base}/api/docs`)).json(), []);
    // Same posture in the other direction: B's doc, A refuses.
    assert.equal((await jpost(B.base, "/api/docs", { name: "beta-doc", html: "<h1>B</h1><p>body</p>" })).status, 200);
    await sseB.waitFor((f) => f.ev === "wicked.interactive.doc.created" && forDoc("beta-doc")(f));
    await sleep(800);
    assert.ok((await health(A.base)).unknown_doc_refused >= 1, "A refuses B's frames symmetrically");
    assert.equal(sseA.frames.filter(forDoc("beta-doc")).length, 0);
  } finally { sseA.close(); sseB.close(); }
});

test("S-L7: demo.requested for A's demo doc reaches A's recorder exactly once; B's recorder never runs and B refuses (no ack-by-silence, no dead letter)", async () => {
  const { listDeadLetters } = await import("wicked-bus");
  const sseA = await openSse(A.base);
  const sseB = await openSse(B.base);
  try {
    const deadBefore = listDeadLetters(busDb()).length;
    const refusedB0 = (await health(B.base)).unknown_doc_refused;
    assert.equal((await jpost(A.base, "/api/docs", { name: "alpha-demo", kind: "demo", url: "http://127.0.0.1:1/", brief: "a demo" })).status, 200);
    await sseA.waitFor((f) => f.ev === "wicked.interactive.doc.created" && forDoc("alpha-demo")(f));

    // Auto-install is ON in both fakes: the OWNING bridge's materializer provisions first (one
    // honest attempt, which this fake fails) and acks with the typed error. Before per-root
    // identity, B could drain this command instead — and, owning no such doc, ack it silently.
    const r = await jpost(A.base, "/api/events", { event_type: "wicked.interactive.demo.requested", payload: { document_id: "alpha-demo" } });
    assert.equal(r.status, 200);
    const err = await sseA.waitFor((f) => f.ev === "wicked.interactive.status.posted" && forDoc("alpha-demo")(f) && f.data.payload.state === "error", 10000);
    assert.equal(err.data.payload.code, "recorder_browser_install_failed");
    // Full retry budget (200 ms + 1 s backoff) plus a poll cycle — nothing may replay anywhere.
    await sleep(2500);

    assert.equal(A.recorder.installs, 1, "root A's recorder ran exactly once (10/10 would be 10 requests → 10 attempts)");
    assert.equal(B.recorder.installs, 0, "root B's recorder never ran for A's doc");
    assert.ok((await health(B.base)).unknown_doc_refused > refusedB0, "B refused the foreign demo.requested loudly");
    assert.equal(sseB.frames.filter(forDoc("alpha-demo")).length, 0, "B's SSE clients saw none of it");
    assert.equal(listDeadLetters(busDb()).length, deadBefore, "refusal is an ack, not a throw — no dead letter from either bridge");
    const st = await (await fetch(`${A.base}/d/alpha-demo/api/demo/status`)).json();
    assert.equal(st.state, "failed");
    assert.equal((await fetch(`${B.base}/d/alpha-demo/api/demo/status`)).status, 404);
  } finally { sseA.close(); sseB.close(); }
});
