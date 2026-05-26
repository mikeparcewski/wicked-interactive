// sse.js — Server-Sent Events client + a pure frame parser (ADR-0006 transport).

/** Parse a single SSE frame ("event: x\ndata: {...}") into { event, data }. */
export function parseFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  let parsed = data;
  try { parsed = data ? JSON.parse(data) : {}; } catch { /* leave as string */ }
  return { event, data: parsed };
}

/**
 * Connect to the service SSE endpoint. `handlers` maps event name -> (data) => void.
 * Returns the EventSource so the caller can close it. Browser-only (uses EventSource).
 */
export function connectEvents(url, handlers) {
  const es = new EventSource(url);
  for (const [event, fn] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      let data = {};
      try { data = e.data ? JSON.parse(e.data) : {}; } catch { /* ignore */ }
      fn(data);
    });
  }
  return es;
}
