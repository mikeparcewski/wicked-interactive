// api.js — thin client for the service HTTP API.

export const docUrl = (version) => (version == null ? "/doc" : `/doc/${version}`);

export async function getVersions() {
  const r = await fetch("/api/versions");
  if (!r.ok) throw new Error("failed to load versions");
  return r.json();
}

export async function postFeedback(items) {
  const r = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "feedback failed");
  return body;
}

// Fork / "start again from here" (ADR-0008): non-destructive.
export async function postFork(from) {
  const r = await fetch("/api/fork", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "fork failed");
  return body;
}

// Export the given version to self-contained HTML or PDF (ADR-0009).
export async function postExport(version, format) {
  const r = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, format }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "export failed");
  return body;
}
