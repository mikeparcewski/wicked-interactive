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

const now = () => new Date().toISOString();

/** A fresh manifest seeded with version 0 (the initial build). */
export function initManifest(htmlFile = "_v0.html") {
  return {
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
export function addVersion(manifest, { parent = manifest.head, feedbackFile = null } = {}) {
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
  };
  return {
    manifest: { head: version, versions: [...manifest.versions, entry] },
    version,
  };
}

/**
 * Record a version with an explicit number (used by the feedback flow, which allocates
 * the number when it writes `_v{n}.md` — before the HTML exists). Write-once: refuses to
 * overwrite an existing version. Advances head to the recorded version.
 */
export function recordVersion(manifest, { version, parent, feedbackFile = null }) {
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
  };
  return { manifest: { head: version, versions: [...manifest.versions, entry] }, version };
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
  return addVersion(manifest, { parent: from, feedbackFile: null });
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
