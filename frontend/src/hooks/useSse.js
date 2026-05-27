import { useEffect, useRef } from "react";
import { connectEvents } from "../lib/sse.js";

/**
 * Subscribe to the service SSE stream. `handlers` maps event name -> callback.
 * The latest handlers are always used without re-opening the connection.
 */
export function useSse(url, handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const es = connectEvents(url, {
      "html-updated": (d) => ref.current["html-updated"]?.(d),
      processed: (d) => ref.current.processed?.(d),
      status: (d) => ref.current.status?.(d),
      answer: (d) => ref.current.answer?.(d),
      error: (d) => ref.current.error?.(d),
      ready: (d) => ref.current.ready?.(d),
    });
    return () => es.close();
  }, [url]);
}
