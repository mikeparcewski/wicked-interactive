// bus-client.js — the service's wicked-bus wiring (ADR-0019, ADR-0021).
//
// The bus is the control plane and is REQUIRED: static import, fail-fast. If the DB can't
// open, serve must not start (the old fire-and-forget bus.js swallowed everything — that
// was right when the bus was optional telemetry; it's wrong now that the bus IS the loop).
//
// This module owns the single DB handle + config for the service process. Emits are
// validated against the ownership table in events.js before they touch the bus, so a coding
// mistake (service emitting an agent-only type) fails loudly in tests rather than poisoning
// the stream at runtime.

import { emit, subscribe, openDb, loadConfig } from "wicked-bus";
import { DOMAIN, subdomainOf, canEmit, isKnownType } from "./events.js";

let _db = null;
let _config = null;

/** Memoized config. Honors WICKED_BUS_DATA_DIR / ~/.something-wicked defaults. */
export function busConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

/**
 * Format a subscribe/poll error for stderr. A silent watch — e.g. WB-003
 * (CURSOR_BEHIND_TTL_WINDOW) — is indistinguishable from "quiet, no events" (the interactive#42
 * failure mode), so subscription errors must always be surfaced, never swallowed. WBError carries
 * `.error` (e.g. "WB-003") and `.code` (e.g. "CURSOR_BEHIND_TTL_WINDOW"); include both when present.
 * @param {string} plugin subscription/plugin name
 * @param {*} err the error thrown by the poll/push loop
 * @returns {string} a single-line, greppable message
 */
export function formatSubscriptionError(plugin, err) {
  const parts = [err && err.error, err && err.code].filter(Boolean);
  const tag = parts.length ? ` ${parts.join("/")}` : "";
  // Guard null/undefined so a missing error doesn't render the literal
  // string "null"/"undefined"; fall back to a generic label instead.
  const msg = err ? (err.message || String(err)) : "Unknown error";
  return `[wicked-bus] subscription '${plugin}' error${tag}: ${msg}`;
}

/** Memoized open DB handle (better-sqlite3, WAL). Throws if the bus can't open. */
export function busDb() {
  if (!_db) _db = openDb(busConfig());
  return _db;
}

/**
 * Emit a domain event after validating the type + producer against events.js.
 * @param {string} type   a known wicked.<noun>.<verb> type
 * @param {object} payload must carry document_id; ts is injected if absent
 * @param {{producer:string, correlationId?:string, sessionId?:string}} ctx
 * @returns {Promise<{event_id:number, idempotency_key:string}>}
 */
export async function emitEvent(type, payload, { producer, correlationId, sessionId } = {}) {
  if (!isKnownType(type)) throw new Error(`unknown event type: ${type}`);
  if (producer && !canEmit(type, producer)) {
    throw new Error(`${producer} may not emit ${type}`);
  }
  return emit(busDb(), busConfig(), {
    event_type: type,
    domain: DOMAIN,
    subdomain: subdomainOf(type),
    payload: { ts: new Date().toISOString(), ...payload },
    producer_id: producer,
    correlation_id: correlationId,
    session_id: sessionId,
  });
}

/**
 * Start a managed subscription on this process's DB. Thin wrapper over the wicked-bus
 * `subscribe()` push-loop: injects the shared db, defaults the poll cadence to 500ms
 * (≥ the 250ms anti-pattern floor) and turns on a small retry budget + DLQ. The caller's
 * `handler(event)` receives a parsed event; throwing retries then dead-letters.
 * @returns {{stop:()=>Promise<void>, getLag:()=>object, cursor_id:string, subscription_id:string}}
 */
export function startSubscription({ plugin, filter, handler, cursorInit = "latest", pollIntervalMs = 500, maxRetries = 2, onError, onDeadLetter } = {}) {
  return subscribe({
    db: busDb(),
    plugin,
    filter,
    handler,
    cursor_init: cursorInit,
    pollIntervalMs,
    maxRetries,
    backoffMs: [200, 1000],
    // Never swallow subscribe/poll errors. A silent watch (e.g. WB-003 CURSOR_BEHIND_TTL_WINDOW)
    // is indistinguishable from "quiet, no events" — the interactive#42 failure mode. Default to
    // surfacing on stderr so a stalled subscription is visible; callers may still pass their own.
    onError: onError || ((err) => console.error(formatSubscriptionError(plugin, err))),
    onDeadLetter,
  });
}

/** Close the DB handle (tests + clean shutdown). Idempotent. */
export function closeBus() {
  if (_db) { try { _db.close(); } catch { /* already closed */ } _db = null; }
  _config = null;
}
