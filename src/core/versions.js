// versions.js — parent-pointer version manifest (ADR-0008).
//
// versions.json:
//   {
//     "head": 2,
//     "versions": [
//       { "version": 0, "parent": null, "feedback_file": null, "html_file": "_v0.html", "created_at": "..." },
//       { "version": 1, "parent": 0, "feedback_file": "_v1.md", "html_file": "_v1.html", "created_at": "..." },
//       { "version": 2, "parent": 0, "feedback_file": "_v2.md", "html_file": "_v2.html", "created_at": "..." }  // a fork of v0
//     ]
//   }
//
// Monotonic version numbers (a fork's child may be _v7 with parent _v3).
// Write-once (INV-4): existing entries are never mutated or removed.
//
// Provenance (DES-CHAT-ARTIFACTS-001 §6.2, slice I1): every entry recorded from I1 on also carries
// `kind` (what landed it: deterministic, structural, generated, fork, demo, theme) and `run_id`
// (the governed run that made it, or null when no run did: a hand edit, a fork, a learn). An entry
// recorded before I1 has neither key, so a reader can tell "made by hand" (run_id: null) from
// "unknown" (no run_id key). v0 is the root a document starts from, never a step, and has neither.

const now = () => new Date().toISOString();

/**
 * A fresh manifest seeded with version 0 (the initial build). `kind` distinguishes a
 * demo workspace ("demo") from an ordinary document; it's omitted for plain docs so
 * existing manifests stay byte-identical (listDocs defaults a missing kind to "doc").
 * `style` is the requested output format (`web` / `ppt` / `brochure` / `doc`, POST /api/docs
 * `style`) — a creation-time fact like `kind`, recorded once so the exporter can honour it
 * (F-050: a brochure is never paginated as a slide deck). Omitted when none was requested.
 */
export function initManifest(htmlFile = "_v0.html", { kind, style } = {}) {
  return {
    ...(kind && kind !== "doc" ? { kind } : {}),
    ...(typeof style === "string" && style ? { style } : {}),
    head: 0,
    versions: [{ version: 0, parent: null, feedback_file: null, html_file: htmlFile, created_at: now() }],
  };
}

function nextNumber(manifest) {
  return manifest.versions.reduce((max, v) => Math.max(max, v.version), -1) + 1;
}

export function getVersion(manifest, version) {
  return manifest.versions.find((v) => v.version === version) || null;
}

/**
 * Append a new version whose parent is `parent` (defaults to current head).
 * Returns { manifest, version } — manifest is a new object (no in-place mutation of entries).
 */
export function addVersion(manifest, { parent = manifest.head, feedbackFile = null, kind = null, runId = null } = {}) {
  if (getVersion(manifest, parent) == null) {
    throw new Error(`addVersion: parent v${parent} does not exist`);
  }
  const version = nextNumber(manifest);
  const entry = {
    version,
    parent,
    feedback_file: feedbackFile,
    html_file: `_v${version}.html`,
    created_at: now(),
    ...provenance(kind, runId),
  };
  return {
    manifest: { ...manifest, head: version, versions: [...manifest.versions, entry] },
    version,
  };
}

/**
 * Record a version with an explicit number (used by the feedback flow, which allocates
 * the number when it writes `_v{n}.md` — before the HTML exists). Write-once: refuses to
 * overwrite an existing version. Advances head to the recorded version.
 */
export function recordVersion(manifest, { version, parent, feedbackFile = null, kind = null, runId = null }) {
  if (getVersion(manifest, version) != null) throw new Error(`recordVersion: v${version} already exists`);
  if (parent != null && getVersion(manifest, parent) == null) {
    throw new Error(`recordVersion: parent v${parent} does not exist`);
  }
  const entry = {
    version,
    parent,
    feedback_file: feedbackFile,
    html_file: `_v${version}.html`,
    created_at: now(),
    ...provenance(kind, runId),
  };
  return { manifest: { ...manifest, head: version, versions: [...manifest.versions, entry] }, version };
}

/** The provenance keys every entry recorded from I1 on carries (see the header). */
function provenance(kind, runId) {
  return { kind: kind ?? null, run_id: runId ?? null };
}

/**
 * The `wicked.interactive.version.created` payload for a version that just landed: the same
 * `parent`, `kind` and `run_id` the manifest entry records (run_id null when no run made it), so
 * the announce and the record never disagree. `document_id` / `project_id` are stamped by the
 * service emit.
 */
export function versionCreated({ version, parent, kind, runId = null, htmlFile = `_v${version}.html` }) {
  return { version, parent, kind, run_id: runId ?? null, html_file: htmlFile };
}

/**
 * A landing's optional `run_id` (DES-CHAT-ARTIFACTS-001 §6.2): absent or null means no run made
 * it (exactly as before I1); otherwise a non-empty string of at most 200 characters (code points,
 * as JSON Schema's maxLength counts them) without control characters — the `run_id` schema of
 * draft.completed and edit.completed says the same. Returns `{ runId }` or `{ problem }`; a caller
 * lands nothing on a problem, because a dropped id would record a run's version as a hand edit.
 */
export function readRunId(value) {
  if (value === undefined || value === null) return { runId: null };
  if (typeof value !== "string" || value.length === 0 || [...value].length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    return { problem: "run_id must be a non-empty string of at most 200 characters" };
  }
  return { runId: value };
}

/**
 * A landing's optional `expect_head`: absent or null means unchecked (as before I1); otherwise the
 * version number the landing was made against. Returns `{ expectHead }` or `{ problem }`.
 */
export function readExpectHead(value) {
  if (value === undefined || value === null) return { expectHead: null };
  if (!Number.isInteger(value) || value < 0) return { problem: "expect_head must be a version number" };
  return { expectHead: value };
}

/** Is this manifest tombstoned (the doc retired)? */
export function isRetired(manifest) {
  return typeof manifest?.retired_at === "string" && manifest.retired_at.length > 0;
}

/**
 * Retire (tombstone) a document: stamp `retired_at` on the manifest. SOFT retire on purpose —
 * the versions array, parent pointers, and every `_v{n}.html` on disk are untouched, so the
 * lineage stays write-once (INV-4) and auditable; only the doc's LIFE ends. Idempotent: an
 * already-retired manifest comes back unchanged with its original timestamp (`already: true`).
 * @returns {{ manifest: object, retired_at: string, already: boolean }}
 */
export function retireManifest(manifest) {
  if (isRetired(manifest)) return { manifest, retired_at: manifest.retired_at, already: true };
  const retired_at = now();
  return { manifest: { ...manifest, retired_at }, retired_at, already: false };
}

/** Next version number that would be allocated (max + 1). */
export function nextVersionNumber(manifest) {
  return nextNumber(manifest);
}

/**
 * Fork from an existing version (AC-21): non-destructive — creates a new head whose
 * parent is `from`; all existing versions remain. "Start again from here".
 */
export function fork(manifest, from) {
  if (getVersion(manifest, from) == null) throw new Error(`fork: v${from} does not exist`);
  return addVersion(manifest, { parent: from, feedbackFile: null, kind: "fork" });
}

/** The chain of ancestors from a version back to the root (inclusive), root-first. */
export function ancestry(manifest, version) {
  const chain = [];
  let v = getVersion(manifest, version);
  while (v) {
    chain.unshift(v.version);
    v = v.parent == null ? null : getVersion(manifest, v.parent);
  }
  return chain;
}

/** Every version is reachable (AC-22): no entry is ever removed, so all are listed. */
export function allVersions(manifest) {
  return [...manifest.versions].sort((a, b) => a.version - b.version);
}
