// crew-projects.test.js — the wizard's project-creation passthrough (#167).
//
// POST /api/crew/projects is a same-origin proxy onto crew's POST /api/v1/projects: the browser
// can't call crew cross-origin, and interactive must never mint a project id of its own. A stub
// crew (plain node:http, like the crewAvailable test in preflight.test.js) stands in for the
// daemon so the tests are deterministic and offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";

process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-crewproj-"));

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "wi-crewproj-"));
  const svc = createMultiServer({ root });
  const port = await svc.start(0);
  return {
    base: `http://localhost:${port}`,
    cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** A stub of crew's POST /api/v1/projects. Records every create so we assert what we forwarded. */
function stubCrew({ status = 201, body = null } = {}) {
  const creates = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/v1/projects") {
        const parsed = JSON.parse(raw || "{}");
        creates.push(parsed);
        res.statusCode = status;
        // Crew's real envelope: 201 { project: {...} } on success, { error } otherwise.
        res.end(JSON.stringify(body ?? { project: { id: "proj_new1", name: parsed.name, status: "active" } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((started) => {
    server.listen(0, "127.0.0.1", () => {
      started({
        base: `http://127.0.0.1:${server.address().port}`,
        creates,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("POST /api/crew/projects forwards the name to crew and returns {id, name}", async () => {
  const crew = await stubCrew();
  const prev = process.env.WICKED_CREW_API;
  process.env.WICKED_CREW_API = crew.base;
  const { base, cleanup } = await boot();
  try {
    const r = await fetch(`${base}/api/crew/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  keystone  " }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: "proj_new1", name: "keystone" });
    // Exactly one create, with the TRIMMED name — the id came from crew, never from us.
    assert.deepEqual(crew.creates, [{ name: "keystone" }]);
  } finally {
    if (prev === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = prev;
    await crew.close();
    await cleanup();
  }
});

test("POST /api/crew/projects surfaces crew's own refusal with its 4xx status", async () => {
  const crew = await stubCrew({ status: 400, body: { error: "Invalid request body" } });
  const prev = process.env.WICKED_CREW_API;
  process.env.WICKED_CREW_API = crew.base;
  const { base, cleanup } = await boot();
  try {
    const r = await fetch(`${base}/api/crew/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(r.status, 400, "a crew 4xx is about the REQUEST — keep its status");
    assert.match((await r.json()).error, /Invalid request body/);
  } finally {
    if (prev === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = prev;
    await crew.close();
    await cleanup();
  }
});

test("POST /api/crew/projects returns a 502 {error} when crew is unreachable", async () => {
  const prev = process.env.WICKED_CREW_API;
  process.env.WICKED_CREW_API = "http://127.0.0.1:1"; // guaranteed refused
  const { base, cleanup } = await boot();
  try {
    const r = await fetch(`${base}/api/crew/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "keystone" }),
    });
    assert.equal(r.status, 502);
    const body = await r.json();
    assert.match(body.error, /unreachable/);
    assert.equal(body.id, undefined, "no id is invented when crew never answered");
  } finally {
    if (prev === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = prev;
    await cleanup();
  }
});

test("POST /api/crew/projects rejects a blank name without dialing crew", async () => {
  const crew = await stubCrew();
  const prev = process.env.WICKED_CREW_API;
  process.env.WICKED_CREW_API = crew.base;
  const { base, cleanup } = await boot();
  try {
    const r = await fetch(`${base}/api/crew/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(r.status, 400);
    assert.equal(crew.creates.length, 0, "an empty name never reaches crew");
  } finally {
    if (prev === undefined) delete process.env.WICKED_CREW_API; else process.env.WICKED_CREW_API = prev;
    await crew.close();
    await cleanup();
  }
});
