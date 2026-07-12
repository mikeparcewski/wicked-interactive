// bridge.test.js — the bus round-trip (ADR-0019): UI emits → service materializes → facts
// fan back to the browser over SSE. A scripted "agent" (emitting straight onto the bus)
// stands in for the supervising Claude session so the structural loop is proven end-to-end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-bridge-"));
const { createMultiServer } = await import("../src/service/server.js");
const { emitEvent } = await import("../src/service/bus-client.js");
const { PRODUCERS } = await import("../src/service/events.js");

let svc, base, root;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "wi-bridge-root-"));
  svc = createMultiServer({ root });
  const port = await svc.start(0);
  base = `http://localhost:${port}`;
});
after(async () => {
  await svc.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.WICKED_BUS_DATA_DIR, { recursive: true, force: true });
});

const jpost = (path, body) => fetch(`${base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const createDoc = (name, html = "<h1>Q2 Results</h1><p>body</p>", extra = {}) =>
  jpost("/api/docs", { name, html, ...extra });

// Open the SSE bridge and collect frames; waitFor resolves when a matching frame arrives.
async function openBridge() {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const waiters = [];
  (async () => {
    let buf = "";
    try {
      while (true) {
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
    waitFor(pred, timeoutMs = 6000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("SSE waitFor timeout")); } }, timeoutMs);
      });
    },
    close() { try { reader.cancel(); } catch {} },
  };
}
const isType = (t, doc) => (f) => f.ev === t && f.data.payload?.document_id === doc;

test("POST /api/docs emits wicked.interactive.doc.created onto the SSE bridge", async () => {
  const bridge = await openBridge();
  try {
    assert.equal((await createDoc("alpha")).status, 200);
    const f = await bridge.waitFor(isType("wicked.interactive.doc.created", "alpha"));
    assert.equal(f.data.producer_id, PRODUCERS.SERVICE);
    assert.equal(f.data.payload.kind, "html");
  } finally { bridge.close(); }
});

test("UI feedback.submitted → service applies it → version.created + feedback.processed fan back", async () => {
  await createDoc("beta");
  const bridge = await openBridge();
  try {
    const r = await jpost("/api/events", {
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "beta", items: [{ selector: "slide-0-heading-1", type: "content-edit", before: "Q2 Results", value: "Q3 Results" }] },
    });
    assert.equal(r.status, 200);
    const vc = await bridge.waitFor(isType("wicked.interactive.version.created", "beta"));
    assert.equal(vc.data.payload.kind, "deterministic");
    assert.equal(vc.data.payload.version, 1);
    const fp = await bridge.waitFor(isType("wicked.interactive.feedback.processed", "beta"));
    assert.equal(fp.data.payload.awaiting_structural, 0);
    // The version really landed on disk with the edit applied.
    const html = await (await fetch(`${base}/d/beta/doc`)).text();
    assert.match(html, /Q3 Results/);
  } finally { bridge.close(); }
});

test("structural loop: feedback.processed carries fragments → scripted agent emits edit.completed → new version", async () => {
  await createDoc("gamma");
  const bridge = await openBridge();
  try {
    // 1. UI asks for a structural change.
    await jpost("/api/events", {
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "gamma", items: [{ selector: "slide-0-heading-1", type: "structural-change", instruction: "punchier" }] },
    });
    // 2. Service lands the v1 partial and hands the structural item to the agent (inline).
    const fp = await bridge.waitFor(isType("wicked.interactive.feedback.processed", "gamma"));
    assert.equal(fp.data.payload.awaiting_structural, 1);
    const item = fp.data.payload.structural_items[0];
    assert.match(item.fragment, /data-wid="slide-0-heading-1"/);

    // 3. The "agent" edits the fragment (PRESERVING the data-wid — INV-2) and emits the result.
    const edited = item.fragment.replace(/Q2 Results/, "Q2 — Crushed It");
    await emitEvent("wicked.interactive.edit.completed",
      { document_id: "gamma", version: fp.data.payload.version, results: [{ selector: item.selector, fragment: edited }] },
      { producer: PRODUCERS.AGENT });

    // 4. Service applies it through the INV-2 gate → a new structural version fans back.
    const vc = await bridge.waitFor((f) => f.ev === "wicked.interactive.version.created" && f.data.payload.document_id === "gamma" && f.data.payload.kind === "structural");
    assert.equal(vc.data.payload.version, 2);
    const html = await (await fetch(`${base}/d/gamma/doc`)).text();
    assert.match(html, /Crushed It/);
    assert.match(html, /data-wid="slide-0-heading-1"/, "data-wid preserved (INV-2)");
  } finally { bridge.close(); }
});

test("agent draft.completed lands a generated first draft for a source doc", async () => {
  await createDoc("delta", "", { kind: "source", brief: "a teaser" });
  const bridge = await openBridge();
  try {
    await emitEvent("wicked.interactive.draft.completed",
      { document_id: "delta", html: "<section><h1>Investor Update</h1><p>Numbers.</p></section>" },
      { producer: PRODUCERS.AGENT });
    const vc = await bridge.waitFor((f) => f.ev === "wicked.interactive.version.created" && f.data.payload.document_id === "delta" && f.data.payload.kind === "generated");
    assert.ok(vc.data.payload.version >= 1);
    assert.match(await (await fetch(`${base}/d/delta/doc`)).text(), /Investor Update/);
  } finally { bridge.close(); }
});

test("chat.posted fans to the bridge and persists to the transcript", async () => {
  await createDoc("epsilon");
  const bridge = await openBridge();
  try {
    await jpost("/api/events", { event_type: "wicked.interactive.chat.posted", payload: { document_id: "epsilon", role: "user", text: "make it premium" } });
    await bridge.waitFor(isType("wicked.interactive.chat.posted", "epsilon"));
    // The bridge persisted it to conversation.jsonl (read back via the per-doc state-plane route).
    const convo = await (await fetch(`${base}/d/epsilon/api/conversation`)).json();
    assert.ok(convo.some((m) => m.role === "user" && /premium/.test(m.text)), "chat persisted");
  } finally { bridge.close(); }
});

test("source.attached persists to sources.json (materialized by the command loop)", async () => {
  await createDoc("zeta");
  const bridge = await openBridge();
  try {
    await jpost("/api/events", { event_type: "wicked.interactive.source.attached", payload: { document_id: "zeta", added: [{ path: "/tmp/refs", note: "use" }] } });
    await bridge.waitFor(isType("wicked.interactive.source.attached", "zeta"));
    // Poll the state-plane view until the command loop has persisted (≤ a couple poll cycles).
    let sources = [];
    for (let i = 0; i < 30 && sources.length === 0; i++) {
      sources = (await (await fetch(`${base}/d/zeta/api/sources`)).json()).sources;
      if (sources.length === 0) await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(sources.length, 1);
    assert.equal(sources[0].status, "pending");
  } finally { bridge.close(); }
});

test("POST /api/events enforces the UI whitelist + known doc", async () => {
  await createDoc("eta");
  // Not UI-emittable (only the agent owns edit.completed):
  assert.equal((await jpost("/api/events", { event_type: "wicked.interactive.edit.completed", payload: { document_id: "eta", version: 1, results: [] } })).status, 403);
  // Unknown event type:
  assert.equal((await jpost("/api/events", { event_type: "wicked.bogus.happened", payload: { document_id: "eta" } })).status, 400);
  // Unknown doc:
  assert.equal((await jpost("/api/events", { event_type: "wicked.interactive.chat.posted", payload: { document_id: "nonesuch", role: "user", text: "hi" } })).status, 404);
});

test("idempotency: a re-emitted feedback command does not create a second version", async () => {
  await createDoc("theta");
  const bridge = await openBridge();
  try {
    const payload = { document_id: "theta", items: [{ selector: "slide-0-heading-1", type: "content-edit", value: "Once" }] };
    // Emit the SAME command twice with one shared idempotency_key (as a redelivery would look).
    const { emit } = await import("wicked-bus");
    const { busDb, busConfig } = await import("../src/service/bus-client.js");
    const key = "dupe-key-1";
    const ev = { event_type: "wicked.interactive.feedback.submitted", domain: "wicked-interactive", subdomain: "feedback", payload: { ts: new Date().toISOString(), ...payload }, producer_id: PRODUCERS.UI, idempotency_key: key };
    emit(busDb(), busConfig(), ev);
    await bridge.waitFor(isType("wicked.interactive.version.created", "theta"));
    // Re-emitting the identical idempotency_key is a dedup no-op at the bus (WB-002); the
    // command loop also guards in-process. Either way, head must stay at 1.
    try { emit(busDb(), busConfig(), ev); } catch { /* WB-002 duplicate — expected */ }
    await new Promise((r) => setTimeout(r, 1500));
    const m = await (await fetch(`${base}/d/theta/api/versions`)).json();
    assert.equal(m.head, 1, "no duplicate version from a redelivered command");
  } finally { bridge.close(); }
});
