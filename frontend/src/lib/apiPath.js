// apiPath.js — URL-driven mode detection (ADR-0015). If `?doc=<name>` is set, all
// API/doc/event paths get a `/d/<name>` prefix (multi-doc service); otherwise they fall
// through to the legacy single-workspace routes. Same bundle works in both modes.

export function getCurrentDoc(search) {
  const s = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const d = new URLSearchParams(s).get("doc");
  return d && /^[a-z0-9][a-z0-9-]{0,63}$/.test(d) ? d : null;
}

/** Prepend /d/<doc> if a doc is selected in the URL. Pass legacy paths unchanged. */
export function apiPath(p, doc) {
  const d = doc ?? getCurrentDoc();
  if (!d) return p;
  if (p.startsWith(`/d/${d}/`) || p === `/d/${d}`) return p;
  return `/d/${d}${p.startsWith("/") ? p : `/${p}`}`;
}

/** Convenience for the iframe src (`/doc` or `/doc/{v}`). */
export function docSrc(version) {
  return apiPath(version == null ? "/doc" : `/doc/${version}`);
}

/** Convenience for the SSE endpoint. */
export function eventsUrl() {
  return apiPath("/events");
}

/** Navigate to a doc by name (sets ?doc=<name> and reloads). */
export function navigateToDoc(name) {
  if (typeof window === "undefined") return;
  const u = new URL(window.location.href);
  u.searchParams.set("doc", name);
  window.location.href = u.toString();
}
