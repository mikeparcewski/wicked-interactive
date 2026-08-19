// api-parity.test.js — THE GATE for DES-MERGE-001 slice 18 (§4.10 parity ledger).
//
// The SPA shell is gone; the API surface behind it is not. This walks the routes the merged
// studio app drives — docs, versions, exports, demo, theme, analyze — against a default
// (API-only) bridge and pins them green. A route that moves or disappears here is a parity
// failure for a wicked-interactive user, not an internal refactor.
//
// Deliberately end-to-end-ish but hermetic: no chrome (no PDF), no python (no PPTX), no ffmpeg
// (no GIF), no network. Those code paths have their own suites; this one proves REACHABILITY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiServer } from "../src/service/server.js";

function freshBus() {
  process.env.WICKED_BUS_DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-parity-"));
}

async function boot() {
  freshBus();
  const root = mkdtempSync(join(tmpdir(), "wi-parity-"));
  const svc = createMultiServer({ root });   // default = API-only, exactly what studio talks to
  const port = await svc.start(0);
  return {
    root, svc, base: `http://localhost:${port}`,
    cleanup: async () => { await svc.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

const postJson = (url, body) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("API parity smoke: every capability the merged app drives is reachable on an API-only bridge", async () => {
  const { base, root, cleanup } = await boot();
  try {
    // ── identity + install gate ───────────────────────────────────────────
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.root, root, "/api/health still names the root it serves (ADR-0022 reuse)");

    const preflight = await fetch(`${base}/api/preflight`);
    assert.equal(preflight.status, 200);
    assert.ok(typeof (await preflight.json()) === "object", "the install gate still answers");

    // ── docs: list + create (§4.1) ────────────────────────────────────────
    assert.deepEqual(await (await fetch(`${base}/api/docs`)).json(), []);
    const created = await postJson(`${base}/api/docs`, { name: "parity-doc", html: "<section><h1>Q3</h1><p>body</p></section>" });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).name, "parity-doc");

    const list = await (await fetch(`${base}/api/docs`)).json();
    assert.deepEqual(list.map((d) => d.name), ["parity-doc"]);
    const doc = `${base}/d/parity-doc`;

    // ── versions, fork, rewind (§4.2) ─────────────────────────────────────
    assert.equal((await (await fetch(`${doc}/api/versions`)).json()).head, 0);
    const forked = await postJson(`${doc}/api/fork`, { from: 0 });
    assert.equal(forked.status, 200);
    assert.deepEqual(await forked.json(), { version: 1, parent: 0 });
    assert.equal((await (await fetch(`${doc}/api/versions`)).json()).head, 1);
    assert.match(await (await fetch(`${doc}/doc`)).text(), /data-wid=/, "head HTML still carries INV-2 anchors");
    assert.equal((await fetch(`${doc}/doc/0`)).status, 200);

    // ── export + download (§4.4) ──────────────────────────────────────────
    const exported = await postJson(`${doc}/api/export`, { version: 1, format: "html" });
    assert.equal(exported.status, 200);
    const { download, file } = await exported.json();
    // The URL is doc-scoped by the mount (`/d/<doc>/api/export/file/...`), which is what the
    // merged app resolves against the proxied origin — assert the shape, then pull the bytes.
    assert.ok(file && download === `/d/parity-doc/api/export/file/${encodeURIComponent(file)}`, `unexpected download URL: ${download}`);
    const bytes = await fetch(`${base}${download}`);
    assert.equal(bytes.status, 200);
    assert.match(bytes.headers.get("content-disposition") || "", /attachment/);
    assert.ok((await bytes.text()).length > 0);
    assert.equal((await postJson(`${doc}/api/export`, { version: 1, format: "wat" })).status, 400, "unknown format still refused");

    // ── conversation + sources (§4.6, §4.9) ───────────────────────────────
    assert.ok(Array.isArray(await (await fetch(`${doc}/api/conversation`)).json()));
    assert.ok(Array.isArray((await (await fetch(`${doc}/api/sources`)).json()).sources));

    // ── the event bridge: theme (§4.6) and analyze/review (§4.7) ──────────
    // Both are UI-originated intents over the bus, so "reachable" means POST /api/events accepts
    // them for this doc. Analyze has no studio affordance yet — this route is how it stays usable.
    const themeFile = join(root, "brand.png");
    writeFileSync(themeFile, "not-really-a-png");
    for (const [event_type, payload] of [
      ["wicked.interactive.theme.requested", { path: themeFile }],
      ["wicked.interactive.review.requested", { scope: "intent" }],
      ["wicked.interactive.feedback.submitted", { items: [] }],
      ["wicked.interactive.chat.posted", { role: "user", text: "make it shorter" }],
    ]) {
      const res = await postJson(`${base}/api/events`, { event_type, payload: { document_id: "parity-doc", ...payload } });
      assert.equal(res.status, 200, `${event_type} accepted`);
      assert.ok((await res.json()).event_id, `${event_type} returns an event id`);
    }
    // ...and the whitelist still holds: a service-owned fact can't be forged from a client.
    assert.equal((await postJson(`${base}/api/events`, { event_type: "wicked.interactive.version.created", payload: { document_id: "parity-doc" } })).status, 403);
    assert.equal((await postJson(`${base}/api/events`, { event_type: "wicked.interactive.nope", payload: {} })).status, 400);

    // ── demo docs: spec + player (§4.5) ───────────────────────────────────
    const demo = await postJson(`${base}/api/docs`, { name: "parity-demo", kind: "demo", url: "http://127.0.0.1:9/app", brief: "show sign-up" });
    assert.equal(demo.status, 200);
    assert.equal((await demo.json()).kind, "demo");
    const spec = await (await fetch(`${base}/d/parity-demo/api/versions`)).json();
    assert.equal(spec.kind, "demo", "the storyboard manifest still declares its kind");
    const player = await fetch(`${base}/d/parity-demo/api/demo/player/0`);
    assert.equal(player.status, 200);
    assert.match(await player.text(), /\/d\/parity-demo\/api\/demo\/recording\/_v0\.mp4/, "player points at the doc-scoped recording route");
    assert.equal((await fetch(`${base}/d/parity-demo/api/demo/recording/_v0.mp4`)).status, 404, "unrecorded video is a clean 404");

    // ── activity rehydrate + cross-instance lists (§4.8, §4.9) ────────────
    const activity = await fetch(`${base}/api/docs/parity-doc/activity`);
    assert.equal(activity.status, 200);
    assert.equal((await activity.json()).document_id, "parity-doc");
    assert.equal((await fetch(`${base}/api/docs/nope/activity`)).status, 404);
    assert.ok(Array.isArray((await (await fetch(`${base}/api/projects`)).json()).projects));
    const crew = await fetch(`${base}/api/crew/projects`);   // crew absent → available:false, never an error
    assert.equal(crew.status, 200);
    assert.equal(typeof (await crew.json()).available, "boolean");
    assert.ok(Array.isArray((await (await fetch(`${doc}/api/fs?path=${encodeURIComponent(root)}`)).json()).entries), "path picker still browses");

    // ── the live stream (§3) ──────────────────────────────────────────────
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/api/events`, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") || "", /text\/event-stream/);
    const first = await sse.body.getReader().read();
    assert.match(new TextDecoder().decode(first.value), /event: ready/);
    ctrl.abort();
  } finally { await cleanup(); }
});
