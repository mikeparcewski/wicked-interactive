// bus.js — fire-and-forget wicked-bus emission (ADR-0004).
//
// Events are best-effort: if the bus is missing or slow, the user-facing loop must not
// block or fail (graceful degradation). Emission is detached and non-blocking.
//
// The default emitter is injectable so callers (and tests) can substitute a spy.

import { spawn } from "node:child_process";

export const EVENTS = {
  FEEDBACK_RECEIVED: { type: "presentation.feedback.received", subdomain: "feedback" },
  HTML_UPDATED: { type: "presentation.html.updated", subdomain: "html" },
  EXPORT_REQUESTED: { type: "presentation.export.requested", subdomain: "export" },
};

/** Real emitter: spawns `npx wicked-bus emit` detached. Never throws. */
export function busEmit({ type, subdomain }, payload) {
  if (process.env.WICKED_NO_BUS === "1") return;
  try {
    const child = spawn(
      "npx",
      ["wicked-bus", "emit", "--type", type, "--domain", "presentation",
        "--subdomain", subdomain, "--payload", JSON.stringify(payload)],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    /* graceful degradation — the bus is optional */
  }
}
