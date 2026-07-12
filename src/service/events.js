// events.js — the one event vocabulary the UI, service, and agent all speak (ADR-0019).
//
// Before this, wicked-interactive spoke four overlapping dialects: SSE event names,
// request/response JSON files, agent-facing HTTP endpoints, and fire-and-forget telemetry.
// They're collapsed into a single wicked-bus vocabulary under one domain. This module is
// PURE DATA + PURE FUNCTIONS — no bus, no I/O — so the ownership/whitelist rules are trivially
// testable and both the service (Node lib) and the bridge import the same truth.
//
// Naming follows the wicked-bus convention: event_type is `wicked.<noun>.<past-verb>`,
// semantic and source-agnostic; the publisher lives in `domain`; the functional area lives
// in `subdomain` (never per-document — doc identity is unbounded-cardinality and rides in
// payload.document_id, ADR-0019 D4).

export const DOMAIN = "wicked-interactive";

// The three producers in the loop. The service bridge stamps UI-originated events with
// producer UI so consumers can drop their own emissions (loop safety).
export const PRODUCERS = Object.freeze({
  SERVICE: "wi-service",
  AGENT: "wi-agent",
  UI: "wi-ui",
});

const { SERVICE, AGENT, UI } = PRODUCERS;

// The vocabulary. `owners` is the type-ownership table: who is allowed to emit each type.
// `uiEmittable` gates POST /api/events — the browser may only originate these. `subdomain`
// is the bus column (functional area). Keep this table and event-schemas/ in lockstep.
export const EVENT_TYPES = Object.freeze({
  "wicked.interactive.doc.created":         { subdomain: "docs",       owners: [SERVICE],       uiEmittable: false },
  "wicked.interactive.feedback.submitted":  { subdomain: "feedback",   owners: [UI],            uiEmittable: true  },
  "wicked.interactive.feedback.processed":  { subdomain: "feedback",   owners: [SERVICE],       uiEmittable: false },
  "wicked.interactive.edit.completed":      { subdomain: "feedback",   owners: [AGENT],         uiEmittable: false },
  "wicked.interactive.draft.completed":     { subdomain: "generation", owners: [AGENT],         uiEmittable: false },
  "wicked.interactive.chat.posted":         { subdomain: "chat",       owners: [UI, AGENT],     uiEmittable: true  },
  "wicked.interactive.question.answered":   { subdomain: "chat",       owners: [UI],            uiEmittable: true  },
  "wicked.interactive.status.posted":       { subdomain: "status",     owners: [AGENT, SERVICE],uiEmittable: false },
  "wicked.interactive.status.requested":    { subdomain: "status",     owners: [UI],            uiEmittable: true  },
  "wicked.interactive.source.attached":     { subdomain: "sources",    owners: [UI],            uiEmittable: true  },
  "wicked.interactive.source.updated":      { subdomain: "sources",    owners: [AGENT],         uiEmittable: false },
  "wicked.interactive.source.removed":      { subdomain: "sources",    owners: [UI],            uiEmittable: true  },
  "wicked.interactive.demo.requested":      { subdomain: "demo",       owners: [UI, AGENT],     uiEmittable: true  },
  "wicked.interactive.theme.requested":     { subdomain: "theme",      owners: [UI, AGENT],     uiEmittable: true  },
  "wicked.interactive.theme.learned":       { subdomain: "theme",      owners: [SERVICE],       uiEmittable: false },
  "wicked.interactive.review.requested":    { subdomain: "review",     owners: [UI, AGENT],     uiEmittable: true  },
  "wicked.interactive.review.completed":    { subdomain: "review",     owners: [AGENT],         uiEmittable: false },
  "wicked.interactive.version.created":     { subdomain: "versions",   owners: [SERVICE],       uiEmittable: false },
  "wicked.interactive.export.requested":    { subdomain: "export",     owners: [SERVICE],       uiEmittable: false },
  // Export gate (ADR-0009 follow-up): the service announces a freshly-rendered artifact with its
  // path so the supervising agent can vision-review it BEFORE the user is told it's good; the
  // agent posts its verdict back as wicked.export.reviewed.
  "wicked.interactive.export.generated":    { subdomain: "export",     owners: [SERVICE],       uiEmittable: false },
  "wicked.interactive.export.reviewed":     { subdomain: "export",     owners: [AGENT],         uiEmittable: false },
  "wicked.interactive.error.raised":        { subdomain: "error",      owners: [SERVICE],       uiEmittable: false },
});

/** Subscription filter that catches every event this system emits. */
export const ALL_FILTER = `*@${DOMAIN}`;

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

/** The producers allowed to emit `type`. Empty array for an unknown type. */
export function ownerOf(type) {
  return isKnownType(type) ? EVENT_TYPES[type].owners : [];
}

export function subdomainOf(type) {
  if (!isKnownType(type)) throw new Error(`unknown event type: ${type}`);
  return EVENT_TYPES[type].subdomain;
}

/** May the browser originate this event type via POST /api/events? */
export function uiEmittable(type) {
  return isKnownType(type) && EVENT_TYPES[type].uiEmittable === true;
}

/** May `producer` emit `type`? Enforced on every emit (loop safety + intent). */
export function canEmit(type, producer) {
  return ownerOf(type).includes(producer);
}
