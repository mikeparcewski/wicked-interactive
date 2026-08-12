// DES-PROJECT-001 §2.3/§7 — the additive crew-project binding, and the regression that matters
// most: the OFFLINE / NO-PROJECT solo creator is byte-for-byte unharmed (ADR §8 step 10).
//
// A mock crew daemon (plain node http server) stands in for /api/v1: deterministic, offline,
// records every membership POST so the tests assert what interactive actually sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";
import { initWorkspace } from "../src/service/workspace.js";
import { writeBreadcrumb, loadBreadcrumb, projectIdFor } from "../src/service/project.js";
import { runAdopt } from "../src/artifact/adopt.js";

function freshBus() {
  process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-proj-"));
}

async function boot() {
  freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-proj-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  const base = `http://localhost:${port}`;
  return { root, svc, base, cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); } };
}

/** A recording mock of crew's /api/v1 project surface. */
function mockCrew({ projectId = "proj_mock1", name = "keystone", status = "active" } = {}) {
  const attaches = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const projectPath = `/api/v1/projects/${projectId}`;
      if (req.method === "GET" && req.url === projectPath) {
        res.end(JSON.stringify({ project: { id: projectId, name, status, scope: `project:${projectId}` } }));
        return;
      }
      if (req.method === "POST" && req.url === `${projectPath}/members`) {
        const parsed = JSON.parse(body);
        attaches.push(parsed);
        res.statusCode = 201;
        res.end(JSON.stringify({ member: { id: "pm_x", project_id: projectId, member_kind: parsed.kind, member_ref: parsed.ref }, created: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `Project not found` }));
    });
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      resolveStart({
        base: `http://127.0.0.1:${server.address().port}`,
        attaches,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Read all bus events (better-sqlite3 handle via wicked-bus openDb). */
async function busEvents() {
  const { openDb } = await import("wicked-bus");
  const db = openDb({});
  return db
    .prepare("SELECT event_type, payload FROM events ORDER BY event_id")
    .all()
    .map((r) => ({ event_type: r.event_type, payload: JSON.parse(r.payload) }));
}

// ── The regression that guards the solo creator (§8 step 10) ──────────────────

test("offline/no-project: doc create + iterate is untouched — no breadcrumb, no project_id, no crew calls", async () => {
  // No WICKED_CREW_API pointing anywhere, no `project` field: the binding code path must be
  // completely inert. (A crew daemon that doesn't exist can prove that better than one that
  // does: ANY attempted call would throw loudly.)
  process.env.WICKED_CREW_API = "http://127.0.0.1:1"; // guaranteed unreachable — must never be dialed
  const { base, root, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "solo-doc", html: "<h1>Solo</h1><p>x</p>" }),
    });
    assert.equal(create.status, 200);
    assert.ok(existsSync(join(root, "solo-doc", "versions.json")));
    assert.ok(!existsSync(join(root, "solo-doc", "project.json")), "no breadcrumb for an unbound doc");

    // Iterate: fork produces a version.created — still no project_id anywhere.
    const fork = await fetch(`${base}/d/solo-doc/api/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: 0 }),
    });
    assert.equal(fork.status, 200);

    // A browser trying to SPOOF a binding is stripped: project_id is derived from the
    // breadcrumb only (Copilot #148) — an unbound doc's events carry none, ever.
    const spoof = await fetch(`${base}/api/events`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "wicked.interactive.feedback.submitted",
        payload: { document_id: "solo-doc", version_target: 0, items: [], project_id: "proj_forged" },
      }),
    });
    assert.equal(spoof.status, 200);

    const events = await busEvents();
    assert.ok(events.length >= 3, "doc.created + version.created + feedback emitted locally");
    for (const e of events) {
      assert.equal(e.payload.project_id, undefined, `${e.event_type} must carry NO project_id`);
    }
  } finally {
    delete process.env.WICKED_CREW_API;
    await cleanup();
  }
});

test("project set but crew unreachable: LOUD error, nothing created (never a queued intent)", async () => {
  process.env.WICKED_CREW_API = "http://127.0.0.1:1";
  const { base, root, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "wants-a-home", html: "<p>x</p>", project: "proj_mock1" }),
    });
    assert.equal(create.status, 502);
    const body = await create.json();
    assert.match(body.error, /unreachable/);
    assert.ok(
      !existsSync(join(root, "wants-a-home")),
      "no doc dir on a refused bind — not even an empty one (Copilot #148)",
    );
  } finally {
    delete process.env.WICKED_CREW_API;
    await cleanup();
  }
});

// ── The bound path (§2.3): registration → breadcrumb → enrichment ─────────────

test("create with project: membership registered, breadcrumb beside versions.json, events enriched", async () => {
  const crew = await mockCrew();
  process.env.WICKED_CREW_API = crew.base;
  const { base, root, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "filed-doc", html: "<h1>Filed</h1><p>x</p>", project: "proj_mock1" }),
    });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).project_id, "proj_mock1");

    // 1. Registration is the authority — crew received exactly one interactive.doc attach.
    assert.equal(crew.attaches.length, 1);
    assert.deepEqual(
      { kind: crew.attaches[0].kind, ref: crew.attaches[0].ref, attachedBy: crew.attaches[0].attachedBy },
      { kind: "interactive.doc", ref: "filed-doc", attachedBy: "interactive" },
    );

    // 2. The advisory breadcrumb sits BESIDE versions.json (never inside it).
    const dir = join(root, "filed-doc");
    assert.ok(existsSync(join(dir, "versions.json")));
    const crumb = loadBreadcrumb(dir);
    assert.equal(crumb.project_id, "proj_mock1");
    assert.equal(crumb.project_name, "keystone");
    assert.equal(crumb.crew_api, crew.base);
    assert.ok(crumb.attached_at);
    const manifest = JSON.parse(readFileSync(join(dir, "versions.json"), "utf-8"));
    assert.equal(manifest.project_id, undefined, "the write-once manifest is untouched");

    // 3. Event enrichment: doc.created and a subsequent version.created carry project_id.
    const fork = await fetch(`${base}/d/filed-doc/api/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: 0 }),
    });
    assert.equal(fork.status, 200);
    const events = await busEvents();
    const docCreated = events.find((e) => e.event_type === "wicked.interactive.doc.created");
    const versionCreated = events.find((e) => e.event_type === "wicked.interactive.version.created");
    assert.equal(docCreated.payload.project_id, "proj_mock1");
    assert.equal(versionCreated.payload.project_id, "proj_mock1");
  } finally {
    delete process.env.WICKED_CREW_API;
    await crew.close();
    await cleanup();
  }
});

test("unknown project: 502 with crew's reason, nothing created", async () => {
  const crew = await mockCrew(); // knows only proj_mock1
  process.env.WICKED_CREW_API = crew.base;
  const { base, root, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "lost-doc", html: "<p>x</p>", project: "proj_nope" }),
    });
    assert.equal(create.status, 502);
    assert.match((await create.json()).error, /not found/);
    assert.ok(!existsSync(join(root, "lost-doc")));
    assert.equal(crew.attaches.length, 0);
  } finally {
    delete process.env.WICKED_CREW_API;
    await crew.close();
    await cleanup();
  }
});

test("archived project blocks the bind (crew-side lifecycle honored)", async () => {
  const crew = await mockCrew({ status: "archived" });
  process.env.WICKED_CREW_API = crew.base;
  const { base, cleanup } = await boot();
  try {
    const create = await fetch(`${base}/api/docs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "too-late", html: "<p>x</p>", project: "proj_mock1" }),
    });
    assert.equal(create.status, 502);
    assert.match((await create.json()).error, /archived/);
    assert.equal(crew.attaches.length, 0);
  } finally {
    delete process.env.WICKED_CREW_API;
    await crew.close();
    await cleanup();
  }
});

// ── adopt (§7): breadcrumbs → re-registered memberships ───────────────────────

test("adopt re-registers memberships from breadcrumbs (control-store loss / new machine)", async () => {
  freshBus();
  const crew = await mockCrew();
  const root = mkdtempSync(join(tmpdir(), "wi-adopt-"));
  try {
    // Two docs: one bound (breadcrumb), one solo (must be untouched).
    const bound = join(root, "restored-doc");
    mkdirSync(bound, { recursive: true });
    initWorkspace(bound, "<h1>Restored</h1><p>x</p>");
    writeBreadcrumb(bound, { project_id: "proj_mock1", project_name: "keystone", crew_api: "http://old-machine:1", attached_at: "2026-01-01T00:00:00Z" });
    const solo = join(root, "solo-doc");
    mkdirSync(solo, { recursive: true });
    initWorkspace(solo, "<h1>Solo</h1><p>x</p>");

    const code = await runAdopt({ root, "crew-api": crew.base });
    assert.equal(code, 0);
    assert.equal(crew.attaches.length, 1, "exactly the breadcrumbed doc re-registers");
    assert.equal(crew.attaches[0].ref, "restored-doc");
    assert.equal(crew.attaches[0].kind, "interactive.doc");
    // The breadcrumb's daemon coordinates refreshed; the binding identity kept.
    const crumb = loadBreadcrumb(bound);
    assert.equal(crumb.crew_api, crew.base);
    assert.equal(crumb.project_id, "proj_mock1");
    assert.equal(projectIdFor(solo), null, "the solo doc stays unbound");
  } finally {
    await crew.close();
    rmSync(root, { recursive: true, force: true });
  }
});
