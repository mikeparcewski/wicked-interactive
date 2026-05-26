import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame } from "../frontend/src/lib/sse.js";

test("parses an event + JSON data frame", () => {
  const { event, data } = parseFrame('event: html-updated\ndata: {"version":1,"html_file":"_v1.html"}');
  assert.equal(event, "html-updated");
  assert.deepEqual(data, { version: 1, html_file: "_v1.html" });
});

test("defaults event to 'message' and tolerates non-JSON data", () => {
  const { event, data } = parseFrame("data: hello");
  assert.equal(event, "message");
  assert.equal(data, "hello");
});

test("empty data parses to {}", () => {
  const { event, data } = parseFrame("event: ready\ndata: ");
  assert.equal(event, "ready");
  assert.deepEqual(data, {});
});
