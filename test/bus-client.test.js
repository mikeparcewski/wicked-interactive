// bus-client.test.js — the service's wicked-bus wiring (ADR-0019).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "wi-bus-client-"));
process.env.WICKED_BUS_DATA_DIR = DATA_DIR;

const { emitEvent, busDb, closeBus, formatSubscriptionError } = await import("../src/service/bus-client.js");

after(() => { try { closeBus(); } catch {} rmSync(DATA_DIR, { recursive: true, force: true }); });

test("formatSubscriptionError surfaces WB-003 code and plugin so a stalled watch is visible (interactive#42)", () => {
  // Shape of a wicked-bus WBError: `.error` = "WB-003", `.code` = machine name.
  const wb003 = Object.assign(new Error("cursor behind retention window"), {
    error: "WB-003", code: "CURSOR_BEHIND_TTL_WINDOW",
  });
  const line = formatSubscriptionError("wi-service-commands", wb003);
  assert.match(line, /wi-service-commands/, "names the subscription");
  assert.match(line, /WB-003/, "surfaces the WB code");
  assert.match(line, /CURSOR_BEHIND_TTL_WINDOW/, "surfaces the machine-readable code");
  assert.match(line, /cursor behind retention window/, "surfaces the message");
});

test("formatSubscriptionError degrades gracefully for a plain error (no WB code)", () => {
  const line = formatSubscriptionError("wi-service-bridge", new Error("boom"));
  assert.match(line, /wi-service-bridge/);
  assert.match(line, /boom/);
  assert.doesNotMatch(line, /undefined/, "no undefined leaks when .error/.code are absent");
});

test("emitEvent lands a well-formed envelope", async () => {
  const { event_id } = await emitEvent("wicked.interactive.version.created", {
    document_id: "t1", version: 1, parent: 0, kind: "fork", html_file: "_v1.html",
  }, { producer: "wi-service" });
  assert.ok(event_id > 0);
  const row = busDb().prepare(
    "SELECT event_type, domain, subdomain, producer_id, payload FROM events WHERE event_id=?"
  ).get(event_id);
  assert.equal(row.event_type, "wicked.interactive.version.created");
  assert.equal(row.domain, "wicked-interactive");
  assert.equal(row.subdomain, "versions");
  assert.equal(row.producer_id, "wi-service");
  const payload = JSON.parse(row.payload);
  assert.equal(payload.document_id, "t1");
  assert.ok(payload.ts, "ts injected automatically");
});

test("emitEvent rejects types the producer doesn't own", async () => {
  await assert.rejects(
    () => emitEvent("wicked.interactive.edit.completed", { document_id: "t1", version: 1, results: [] }, { producer: "wi-service" }),
    /wi-service may not emit wicked\.interactive\.edit\.completed/,
  );
});

test("emitEvent rejects unknown event types", async () => {
  await assert.rejects(
    () => emitEvent("wicked.bogus.happened", { document_id: "t1" }, { producer: "wi-service" }),
    /unknown event type/,
  );
});

test("emitEvent threads correlation_id when supplied", async () => {
  const { event_id } = await emitEvent("wicked.interactive.status.posted", {
    document_id: "t1", state: "complete", message: "done",
  }, { producer: "wi-service", correlationId: "corr-xyz" });
  const row = busDb().prepare("SELECT correlation_id FROM events WHERE event_id=?").get(event_id);
  assert.equal(row.correlation_id, "corr-xyz");
});
