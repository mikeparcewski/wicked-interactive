import { useEffect, useRef } from "react";
import { connectEvents } from "../lib/sse.js";

// The bus event types the browser reacts to (ADR-0019). Each SSE frame's `event:` is the
// event_type and its `data` is the full envelope ({ event_type, payload, producer_id, ... }).
const TYPES = [
  "wicked.version.created",
  "wicked.feedback.processed",
  "wicked.status.posted",
  "wicked.chat.posted",
  "wicked.review.completed",
  "wicked.source.attached",
  "wicked.source.updated",
  "wicked.error.raised",
  "ready",
];

/**
 * Subscribe to the bus SSE bridge. `handlers` maps event_type -> (payload, envelope) => void.
 * Frames are filtered to `docId` (when given) on payload.document_id, so one shared stream
 * serves every doc without cross-talk. Latest handlers are used without reopening the socket.
 */
export function useSse(url, handlers, { docId } = {}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const docRef = useRef(docId);
  docRef.current = docId;
  useEffect(() => {
    const wired = {};
    for (const t of TYPES) {
      wired[t] = (env) => {
        if (t !== "ready" && docRef.current && env?.payload?.document_id !== docRef.current) return;
        ref.current[t]?.(env?.payload ?? {}, env);
      };
    }
    const es = connectEvents(url, wired);
    return () => es.close();
  }, [url]);
}
