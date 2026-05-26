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
