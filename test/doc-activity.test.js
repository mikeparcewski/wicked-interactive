// doc-activity.test.js — the reconnect/rehydrate read (#165).
//
// GET /api/docs/:doc/activity tells a remounting frontend whether a build is in flight for a
// doc: the last status.posted frame the bridge saw (pulses included) plus crew's run list,
// where the doc→run association is the problem-statement marker both crew seams stamp
// (`the wicked-interactive document "<name>"`). A stub crew (plain node:http, like
// crew-projects.test.js) stands in for the daemon so the tests are deterministic and offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-activity-"));
const { createMultiServer } = await import("../src/service/server.js");
const { emitEvent } = await import("../src/service/bus-client.js");
const { PRODUCERS } = await import("../src/service/events.js");

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "wi-activity-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  const createDoc = (name) => fetch(`${base}/api/docs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, html: "<h1>Hi</h1><p>x</p>" }),
  });
  return {
    base, createDoc,
    activity: async (name) => fetch(`${base}/api/docs/${name}/activity`),
    cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** A stub of crew's GET /api/v1/runs — answers with the given SessionView list. */
function stubCrew({ runs = [] } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/v1/runs") {
      res.end(JSON.stringify({ runs }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((started) => {
    server.listen(0, "127.0.0.1", () => {
      started({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A SessionView the way crew's seams shape it: the doc rides in the problem-statement marker. */
const runView = (id, doc, status, workflow = "interactive-draft") => ({
  session: {
    id, workflow_id: workflow, status,
    problem: `Produce the first draft of the wicked-interactive document "${doc}" (requested style: web). The user's brief: hello`,
  },
  units: [],
});

/** Poll the activity read until `pred` holds (the bus subscription delivers asynchronously). */
async function until(fn, pred, tries = 50, everyMs = 100) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

function withCrewApi(value, run) {
  const prev = process.env.WICKED_CREW_API;
  if (value === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = value;
  return run().finally(() => {
    if (prev === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = prev;
  });
}

test("GET /api/docs/:doc/activity 404s on an unknown doc", async () => {
  await withCrewApi("http://127.0.0.1:1", async () => {
    const { activity, cleanup } = await boot();
    try {
      const r = await activity("no-such-doc");
      assert.equal(r.status, 404);
      assert.match((await r.json()).error, /unknown doc/);
    } finally { await cleanup(); }
  });
});

test("an executing crew run bound to the doc reports active + run; another doc's run doesn't", async () => {
  const crew = await stubCrew({ runs: [
    runView("run_other", "some-other-doc", "executing"),
    runView("run_live1", "building-doc", "executing"),
  ] });
  await withCrewApi(crew.base, async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("building-doc")).status, 200);
      assert.equal((await createDoc("idle-doc")).status, 200);

      const busy = await (await activity("building-doc")).json();
      assert.equal(busy.active, true);
      assert.deepEqual(busy.run, { id: "run_live1", workflow_id: "interactive-draft", status: "executing" });

      // The other doc has no run of its own — run_other names a doc that isn't it.
      const idle = await (await activity("idle-doc")).json();
      assert.equal(idle.active, false);
      assert.equal(idle.run, null);
    } finally { await cleanup(); }
  });
  await crew.close();
});

test("a terminal crew run is not activity", async () => {
  const crew = await stubCrew({ runs: [
    runView("run_done1", "finished-doc", "completed"),
    runView("run_fail1", "finished-doc", "failed", "interactive-edit"),
  ] });
  await withCrewApi(crew.base, async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("finished-doc")).status, 200);
      const body = await (await activity("finished-doc")).json();
      assert.equal(body.active, false);
      assert.equal(body.run, null);
    } finally { await cleanup(); }
  });
  await crew.close();
});

test("crew unreachable degrades to inactive — never an error", async () => {
  await withCrewApi("http://127.0.0.1:1", async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("lonely-doc")).status, 200);
      const r = await activity("lonely-doc");
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { document_id: "lonely-doc", active: false, status: null, run: null });
    } finally { await cleanup(); }
  });
});

test("a fresh working pulse means active (assist path, no crew run); a terminal status ends it", async () => {
  await withCrewApi("http://127.0.0.1:1", async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("pulse-doc")).status, 200);

      // The answerer narrates a working pulse — the bridge records it as the doc's last status.
      await emitEvent("wicked.interactive.status.posted",
        { document_id: "pulse-doc", state: "working", message: "Crew phase 2/2: writing the draft…" },
        { producer: PRODUCERS.CREW });
      const busy = await until(
        async () => (await activity("pulse-doc")).json(),
        (b) => b.status !== null,
      );
      assert.equal(busy.active, true, "a fresh working pulse is an in-flight build");
      assert.equal(busy.status.state, "working");
      assert.equal(busy.status.message, "Crew phase 2/2: writing the draft…");
      assert.equal(busy.run, null, "no crew run reachable — the pulse alone carried it");

      // The run lands: a terminal status replaces the pulse and the doc reads idle again.
      await emitEvent("wicked.interactive.status.posted",
        { document_id: "pulse-doc", state: "complete", message: "First draft is in." },
        { producer: PRODUCERS.CREW });
      const done = await until(
        async () => (await activity("pulse-doc")).json(),
        (b) => b.status?.state === "complete",
      );
      assert.equal(done.active, false);
      assert.equal(done.status.message, "First draft is in.");
    } finally { await cleanup(); }
  });
});

test("a stale working pulse is not activity (the answerer heartbeats every ≤15s)", async () => {
  await withCrewApi("http://127.0.0.1:1", async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("stale-doc")).status, 200);
      // emitEvent injects ts only when absent — carry a 2-minute-old one to age the pulse.
      await emitEvent("wicked.interactive.status.posted",
        { document_id: "stale-doc", state: "working", message: "…", ts: new Date(Date.now() - 120_000).toISOString() },
        { producer: PRODUCERS.CREW });
      const body = await until(
        async () => (await activity("stale-doc")).json(),
        (b) => b.status !== null,
      );
      assert.equal(body.status.state, "working");
      assert.equal(body.active, false, "a pulse older than the freshness window reads as dead air");
    } finally { await cleanup(); }
  });
});

test("an asking status is preserved whole so the frontend can restore the question", async () => {
  const crew = await stubCrew({ runs: [runView("run_ask1", "asking-doc", "awaiting_human")] });
  await withCrewApi(crew.base, async () => {
    const { createDoc, activity, cleanup } = await boot();
    try {
      assert.equal((await createDoc("asking-doc")).status, 200);
      await emitEvent("wicked.interactive.status.posted",
        { document_id: "asking-doc", state: "asking", question: "Dark or light theme?", options: ["Dark", "Light"], request_id: "req-1" },
        { producer: PRODUCERS.AGENT });
      const body = await until(
        async () => (await activity("asking-doc")).json(),
        (b) => b.status !== null,
      );
      assert.equal(body.active, true, "an awaiting_human run is in flight");
      assert.deepEqual(body.run, { id: "run_ask1", workflow_id: "interactive-draft", status: "awaiting_human" });
      assert.equal(body.status.state, "asking");
      assert.equal(body.status.question, "Dark or light theme?");
      assert.deepEqual(body.status.options, ["Dark", "Light"]);
      assert.equal(body.status.request_id, "req-1");
    } finally { await cleanup(); }
  });
  await crew.close();
});
