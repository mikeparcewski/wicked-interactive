// doc-retire.test.js — the unmake half of the doc registry (#189).
//
// DELETE /api/docs/:doc SOFT-retires a doc: a `retired_at` tombstone lands in versions.json,
// the doc leaves the default listing and every live surface (410 on /d/:doc/*, the UI emit
// bridge, the activity read), the name stays reserved, and the LINEAGE stays on disk —
// write-once (INV-4), auditable, re-listable via ?includeRetired. The removal is observable:
// the service emits wicked.interactive.doc.retired exactly once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";
import { initManifest, retireManifest, isRetired } from "../src/core/versions.js";

// Crew is unreachable throughout: the in-flight gate must degrade to the local pulse alone
// (never block or slow retirement on a crew that isn't there). 127.0.0.1:1 refuses instantly.
// Saved and restored on exit so a shared-process runner's later tests see the original value.
const PRIOR_CREW_API = process.env.WICKED_CREW_API;
process.env.WICKED_CREW_API = "http://127.0.0.1:1";
process.on("exit", () => {
  if (PRIOR_CREW_API === undefined) delete process.env.WICKED_CREW_API;
  else process.env.WICKED_CREW_API = PRIOR_CREW_API;
});

// Each boot gets an isolated wicked-bus DB (ADR-0019). bus-client memoizes the handle per
// process and releases it on svc.stop() (closeBus), so a fresh dir per boot = fresh bus.
function freshBus() {
  process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-retire-"));
}

async function boot(root = mkdtempSync(join(tmpdir(), "wi-retire-"))) {
  freshBus();
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  const jpost = (path, body) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const createDoc = (name) => jpost("/api/docs", { name, html: "<h1>Hello</h1><p>x</p>" });
  const retire = (name) => fetch(`${base}/api/docs/${name}`, { method: "DELETE" });
  const list = async (qs = "") => (await fetch(`${base}/api/docs${qs}`)).json();
  return {
    root, svc, base, jpost, createDoc, retire, list,
    cleanup: async ({ keepRoot = false } = {}) => {
      await svc.stop();
      if (!keepRoot) rmSync(root, { recursive: true, force: true });
      rmSync(process.env.WICKED_BUS_DATA_DIR, { recursive: true, force: true });
    },
  };
}

/** Poll until `pred(await fn())` holds — the bus subscription delivers asynchronously. */
async function until(fn, pred, tries = 50, everyMs = 100) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

/**
 * Open the SSE bridge and return { frame } — a promise for the first frame matching `ev`.
 * The function itself resolves only once the stream is CONNECTED (response headers in), so
 * callers can open first, then trigger, without racing the bridge fan-out.
 */
async function openSse(base, ev, timeoutMs = 10_000) {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frame = (async () => {
    let buf = "";
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const one = buf.slice(0, i); buf = buf.slice(i + 2);
          let name = "?", data = "";
          for (const line of one.split("\n")) {
            if (line.startsWith("event: ")) name = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (name === ev) return JSON.parse(data);
        }
      }
    } finally { try { reader.cancel(); } catch { /* stream already done */ } }
    throw new Error(`no ${ev} frame within ${timeoutMs}ms`);
  })();
  return { frame };
}

// ── unit: the manifest tombstone ────────────────────────────────────────────

test("retireManifest stamps retired_at and leaves the lineage untouched; idempotent", () => {
  const m0 = initManifest();
  assert.ok(!isRetired(m0));
  const { manifest: m1, retired_at, already } = retireManifest(m0);
  assert.equal(already, false);
  assert.ok(isRetired(m1));
  assert.equal(m1.retired_at, retired_at);
  assert.deepEqual(m1.versions, m0.versions, "versions array untouched (INV-4)");
  assert.equal(m1.head, m0.head);
  const again = retireManifest(m1);
  assert.equal(again.already, true);
  assert.equal(again.retired_at, retired_at, "second retire keeps the original timestamp");
  assert.equal(again.manifest, m1, "already-retired manifest comes back unchanged");
});

// ── API: retire + list + escape hatch + idempotency + 404 ──────────────────

test("DELETE /api/docs/:doc retires: tombstone on disk, lineage kept, list excludes, ?includeRetired shows it", async () => {
  const { root, base, createDoc, retire, list, jpost, cleanup } = await boot();
  try {
    await createDoc("keep-me");
    await createDoc("retire-me");
    await jpost("/d/retire-me/api/fork", { from: 0 }); // give it a second version → real lineage

    const sse = await openSse(base, "wicked.interactive.doc.retired");
    const r1 = await retire("retire-me");
    assert.equal(r1.status, 200);
    const body = await r1.json();
    assert.equal(body.name, "retire-me");
    assert.equal(body.retired, true);
    assert.equal(body.already_retired, false);
    assert.ok(typeof body.retired_at === "string" && !Number.isNaN(Date.parse(body.retired_at)));
    assert.equal(body.versions, 2, "response reports the preserved lineage size");
    assert.ok(body.event_id != null, "first retire carries the emitted event id");

    // The removal is OBSERVABLE (#189): wicked.interactive.doc.retired reaches the bridge.
    const frame = await sse.frame;
    assert.equal(frame.event_type, "wicked.interactive.doc.retired");
    assert.equal(frame.payload.document_id, "retire-me");
    assert.equal(frame.payload.retired_at, body.retired_at);

    // Lineage preserved on disk: every version artifact + the full manifest survive.
    const manifest = JSON.parse(readFileSync(join(root, "retire-me", "versions.json"), "utf-8"));
    assert.equal(manifest.versions.length, 2);
    assert.equal(manifest.retired_at, body.retired_at);
    assert.ok(existsSync(join(root, "retire-me", "_v0.html")));
    assert.ok(existsSync(join(root, "retire-me", "_v1.html")));

    // Default list excludes the tombstone; the escape hatch includes it, flagged.
    const live = await list();
    assert.deepEqual(live.map((d) => d.name), ["keep-me"]);
    for (const qs of ["?includeRetired=1", "?includeRetired=true"]) {
      const all = await list(qs);
      assert.deepEqual(all.map((d) => d.name).sort(), ["keep-me", "retire-me"]);
      const dead = all.find((d) => d.name === "retire-me");
      assert.equal(dead.retired, true);
      assert.equal(dead.retired_at, body.retired_at);
      assert.equal(all.find((d) => d.name === "keep-me").retired, undefined, "live rows carry no retired field");
    }

    // Idempotent: same 200 shape, original timestamp, no second event.
    const r2 = await retire("retire-me");
    assert.equal(r2.status, 200);
    const body2 = await r2.json();
    assert.equal(body2.retired, true);
    assert.equal(body2.already_retired, true);
    assert.equal(body2.retired_at, body.retired_at);
    assert.equal(body2.event_id, undefined, "no re-emit on an idempotent repeat");
  } finally { await cleanup(); }
});

test("retiring a missing or invalid doc is a clean 404 with a JSON body", async () => {
  const { retire, cleanup } = await boot();
  try {
    for (const name of ["no-such-doc", "Bad%20Name", "..%2f..%2fetc"]) {
      const r = await retire(name);
      assert.equal(r.status, 404, `${name} → 404`);
      assert.deepEqual(await r.json(), { error: "unknown doc" });
    }
  } finally { await cleanup(); }
});

// ── API: the retired doc is off every live surface ─────────────────────────

test("a retired doc answers 410 on /d/:doc/*, the emit bridge, and the activity read; its name stays reserved", async () => {
  const { base, createDoc, retire, jpost, cleanup } = await boot();
  try {
    await createDoc("gone");
    assert.equal((await retire("gone")).status, 200);

    // Per-doc routes: a service refusal that says why — not Express's route-missing text.
    for (const path of ["/d/gone/api/versions", "/d/gone/doc", "/d/gone/api/conversation"]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 410, `${path} → 410`);
      const b = await r.json();
      assert.equal(b.error, "doc retired");
      assert.equal(b.document_id, "gone");
      assert.ok(b.retired_at);
    }

    // The bus escape hatch is shut for it too.
    const emit = await jpost("/api/events", {
      event_type: "wicked.interactive.feedback.submitted",
      payload: { document_id: "gone", items: [] },
    });
    assert.equal(emit.status, 410);
    assert.equal((await emit.json()).error, "doc retired");

    // The rehydrate read gives an open canvas a terminal answer instead of "unknown".
    const act = await fetch(`${base}/api/docs/gone/activity`);
    assert.equal(act.status, 410);
    assert.equal((await act.json()).error, "doc retired");

    // The name is reserved by the tombstone — recreating would graft onto an audited lineage.
    const recreate = await jpost("/api/docs", { name: "gone", html: "<p>new life?</p>" });
    assert.equal(recreate.status, 409);
    const rb = await recreate.json();
    assert.equal(rb.retired, true);
    assert.match(rb.error, /retired/);
  } finally { await cleanup(); }
});

test("a tombstone already on disk at boot: excluded from the list, 410 on /d, not mounted", async () => {
  const first = await boot();
  await first.createDoc("old-doc");
  await first.createDoc("still-live");
  assert.equal((await first.retire("old-doc")).status, 200);
  await first.cleanup({ keepRoot: true });

  const second = await boot(first.root); // fresh server, same root, fresh bus
  try {
    assert.deepEqual((await second.list()).map((d) => d.name), ["still-live"]);
    assert.equal((await second.list("?includeRetired=1")).length, 2);
    const r = await fetch(`${second.base}/d/old-doc/api/versions`);
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error, "doc retired");
    // And retire stays idempotent across restarts.
    const again = await second.retire("old-doc");
    assert.equal(again.status, 200);
    assert.equal((await again.json()).already_retired, true);
  } finally { await second.cleanup(); }
});

// ── API: the in-flight decision (issue point 3) — refuse with the reason ────

test("DELETE refuses (409) while a build is in flight, carrying the same activity shape a client already knows", async () => {
  const { base, createDoc, retire, cleanup } = await boot();
  const { emitEvent } = await import("../src/service/bus-client.js");
  const { PRODUCERS } = await import("../src/service/events.js");
  try {
    await createDoc("busy-doc");
    // A fresh 'working' pulse = live work (same signal GET /api/docs/:doc/activity trusts).
    await emitEvent("wicked.interactive.status.posted",
      { document_id: "busy-doc", state: "working", message: "drafting…" },
      { producer: PRODUCERS.AGENT });
    await until(
      async () => (await fetch(`${base}/api/docs/busy-doc/activity`)).json(),
      (a) => a.active === true,
    );
    const r = await retire("busy-doc");
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.active, true);
    assert.equal(body.document_id, "busy-doc");
    assert.match(body.error, /in flight/);
    assert.equal(body.status.state, "working");
    // Refused means untouched: still listed, still serving.
    assert.equal((await (await fetch(`${base}/api/docs`)).json()).length, 1);
    assert.equal((await fetch(`${base}/d/busy-doc/api/versions`)).status, 200);
  } finally { await cleanup(); }
});

test("a DELETE that loses the retire race inside the activity read is the idempotent 200, not a 500", async () => {
  // The window: DELETE B passes the tombstone check, then parks in activityFor's crew fetch
  // (up to 750ms). DELETE A completes the whole retire meanwhile — tombstone on disk, doc
  // unmounted. B must then answer the same 200 {already_retired:true} any other repeat gets;
  // before the mount-refusal guard it fell into mountDoc ("doc retired") → 500.
  const { createServer: createHttp } = await import("node:http");
  let releaseFirst;
  const firstHeld = new Promise((r) => { releaseFirst = r; });
  let calls = 0;
  const crew = createHttp(async (_req, res) => {
    calls += 1;
    if (calls === 1) await firstHeld; // B parks here, inside its activity window
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ runs: [] }));
  });
  await new Promise((r) => crew.listen(0, "127.0.0.1", r));
  const prevCrew = process.env.WICKED_CREW_API;
  process.env.WICKED_CREW_API = `http://127.0.0.1:${crew.address().port}`;
  const { createDoc, retire, cleanup } = await boot();
  try {
    await createDoc("raced-late");
    const b = retire("raced-late"); // enters activityFor and parks on the held crew read
    await until(() => calls, (n) => n >= 1, 100, 20);
    const a = await retire("raced-late"); // full retire completes during B's window
    assert.equal(a.status, 200);
    const aBody = await a.json();
    releaseFirst(); // B resumes AFTER the tombstone landed and the doc was unmounted
    const rB = await b;
    assert.equal(rB.status, 200, "the losing DELETE is the idempotent repeat, not a 500");
    const bBody = await rB.json();
    assert.ok(aBody.retired === true && bBody.retired === true);
    assert.equal([aBody, bBody].filter((x) => x.already_retired === false).length, 1,
      "exactly one of the racing DELETEs is the first retire");
    assert.equal(bBody.retired_at, aBody.retired_at, "one tombstone, one timestamp");
  } finally {
    process.env.WICKED_CREW_API = prevCrew;
    crew.close();
    await cleanup();
  }
});

// ── bus: retired docs no longer materialize commands ────────────────────────

test("a command event for a retired doc is dropped (acked), not materialized and not DLQ'd", async () => {
  const { root, createDoc, retire, cleanup } = await boot();
  const { emitEvent } = await import("../src/service/bus-client.js");
  const { PRODUCERS } = await import("../src/service/events.js");
  try {
    await createDoc("no-more-work");
    assert.equal((await retire("no-more-work")).status, 200);
    // An agent draft landing after retirement: the tombstone is final — no new version appears.
    await emitEvent("wicked.interactive.draft.completed",
      { document_id: "no-more-work", html: "<h1>too late</h1>" },
      { producer: PRODUCERS.AGENT });
    await new Promise((r) => setTimeout(r, 1500)); // > poll interval; give a wrong impl time to act
    const manifest = JSON.parse(readFileSync(join(root, "no-more-work", "versions.json"), "utf-8"));
    assert.equal(manifest.versions.length, 1, "no version materialized after retirement");
    assert.ok(manifest.retired_at);
  } finally { await cleanup(); }
});
