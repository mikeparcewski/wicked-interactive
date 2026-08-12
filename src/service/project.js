// project.js — ADDITIVE crew-project binding (DES-PROJECT-001 §2.3).
//
// Three mechanisms, none of which the doc format depends on:
//   1. REGISTRATION IS THE AUTHORITY: a doc joins a project via crew's
//      `POST /api/v1/projects/:id/members {kind:"interactive.doc", ref:"<doc>"}` — the membership
//      row in crew's control store is the single source of truth for "this doc is in this project".
//   2. A DOC-SIDE BREADCRUMB, ADVISORY ONLY: on successful registration we write `project.json`
//      BESIDE versions.json (never inside it — the write-once version manifest is untouched). It
//      lets the doc display its binding offline and lets `wicked-interactive adopt` re-register
//      after a control-store loss. Breadcrumb and table disagree ⇒ the table wins.
//   3. EVENT ENRICHMENT: a bound doc's `wicked.interactive.*` payloads carry an additive optional
//      `project_id`. Consumers that don't know the field ignore it.
//
// Offline/ungoverned solo creators: no crew daemon reachable ⇒ `--project` is a LOUD error, not a
// queued intent — and with no `--project` nothing here runs at all. Binding is a capability the
// doc gains, never a dependency the doc acquires.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsstore.js";

/** The advisory breadcrumb filename, sibling of versions.json. */
export const BREADCRUMB = "project.json";

/** The crew daemon base URL: `WICKED_CREW_API` env, else crew's default loopback port. */
export function resolveCrewApi() {
  return process.env.WICKED_CREW_API || "http://127.0.0.1:7701";
}

/** Read a doc's breadcrumb; `null` when unbound (or unreadable — advisory, never fatal). */
export function loadBreadcrumb(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, BREADCRUMB), "utf-8"));
  } catch {
    return null;
  }
}

/** The bound project id for a doc dir, or `null`. The event-enrichment read. */
export function projectIdFor(dir) {
  const b = loadBreadcrumb(dir);
  return b && typeof b.project_id === "string" && b.project_id ? b.project_id : null;
}

/** Write the advisory breadcrumb (atomic, like every workspace write). */
export function writeBreadcrumb(dir, info) {
  atomicWrite(join(dir, BREADCRUMB), JSON.stringify(info, null, 2) + "\n");
}

/** fetch with a bounded timeout and a LOUD, actionable error for the offline case. */
async function crewFetch(base, path, init = {}) {
  const url = `${base.replace(/\/$/, "")}${path}`;
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new Error(
      `crew daemon unreachable at ${base} (${e?.cause?.code || e.message}) — ` +
        `--project needs a running crew daemon (or set WICKED_CREW_API); ` +
        `without one, create the doc unbound and attach it later`,
    );
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, body };
}

/**
 * Validate the target project: must exist and be active. Throws with the crew-side reason
 * (unknown project, archived project) so the caller's error IS the operator's remedy.
 */
export async function assertProjectAttachable(crewApi, projectId) {
  const { status, body } = await crewFetch(crewApi, `/api/v1/projects/${encodeURIComponent(projectId)}`);
  if (status === 404) throw new Error(`project ${projectId} not found on the crew daemon at ${crewApi}`);
  if (status !== 200) throw new Error(`crew daemon rejected the project read (${status}): ${body?.error || "unknown error"}`);
  const project = body?.project;
  if (!project || project.status !== "active") {
    throw new Error(`project ${projectId} is ${project?.status || "unreadable"} and blocks new attachments`);
  }
  return project;
}

/**
 * Register `docName` as an `interactive.doc` member of `projectId` (idempotent on crew's side:
 * a duplicate attach is the same membership, 200 instead of 201). Returns crew's member row.
 */
export async function registerDocMembership(crewApi, projectId, docName, meta = {}) {
  const { status, body } = await crewFetch(
    crewApi,
    `/api/v1/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "interactive.doc", ref: docName, meta, attachedBy: "interactive" }),
    },
  );
  if (status !== 200 && status !== 201) {
    throw new Error(`crew daemon refused the membership (${status}): ${body?.error || "unknown error"}`);
  }
  return body;
}

/**
 * The full bind: validate → register → breadcrumb. Call AFTER validation succeeds but the
 * breadcrumb only lands once registration (the authority) has. Returns the breadcrumb object.
 */
export async function bindDocToProject({ dir, docName, projectId, crewApi = resolveCrewApi(), meta = {} }) {
  const project = await assertProjectAttachable(crewApi, projectId);
  await registerDocMembership(crewApi, projectId, docName, meta);
  const breadcrumb = {
    project_id: project.id,
    project_name: project.name,
    crew_api: crewApi,
    attached_at: new Date().toISOString(),
  };
  writeBreadcrumb(dir, breadcrumb);
  return breadcrumb;
}
