// loopback.js — bind a listener to loopback only (wicked-interactive#344).
//
// The bridge is reached only through crew's proxy on this host, so it must never accept a
// connection from another machine. A plain `listen(port)` binds every interface; binding only
// 127.0.0.1 breaks clients that resolve `localhost` to ::1 (Node's fetch and most browsers try
// IPv6 first). So we bind each loopback address on the SAME port: 127.0.0.1 always, plus ::1
// when the host has IPv6. Never the wildcards (0.0.0.0 / ::), and no host override: there is
// no remote mode to opt into.

import { connect } from "node:net";

/** The only addresses a bridge listener ever binds. IPv4 first: it is the one that must work. */
export const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

// A host with IPv6 disabled refuses ::1 with one of these; the IPv4 listener alone is enough then.
const IPV6_UNAVAILABLE = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT", "EINVAL"]);

/** True for an address string a listener of ours may report: 127.0.0.0/8 or ::1. */
export function isLoopbackAddress(address) {
  const a = String(address ?? "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function bindOne(server, port, host) {
  return new Promise((res, rej) => {
    const onError = (e) => { server.off("listening", onListening); rej(e); };
    const onListening = () => { server.off("error", onError); res(server.address().port); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

const closeOne = (server) => new Promise((r) => { try { server.close(() => r()); } catch { r(); } });

// Connect errors that prove nothing listens there: refused, or no such address family/route on
// this host (no IPv6). Anything else, including a timeout, is inconclusive.
const NOBODY_THERE = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH", "EHOSTUNREACH"]);

// Might something be listening on host:port? Only a definitive refusal says no: a live listener
// whose accept queue is full makes the connect hang, and must still count as occupied.
function occupied(host, port, timeoutMs = 1000) {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (v) => { clearTimeout(timer); sock.destroy(); res(v); };
    const timer = setTimeout(() => done(true), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", (e) => done(!NOBODY_THERE.has(e?.code)));
  });
}

function inUse(port) {
  const e = new Error(`listen EADDRINUSE: port ${port} already answers on loopback`);
  e.code = "EADDRINUSE";
  e.port = port;
  return e;
}

/**
 * Listen on every loopback address, one server per address, all on one port.
 * `makeServer()` returns a fresh, unbound net/http server each call (e.g.
 * `() => http.createServer(app)`). `port` 0 lets the OS pick the IPv4 port; when ::1 then finds
 * that port taken, we release it and pick again (bounded). An explicit port that is taken on
 * either address, or that anything already answers on over loopback, rejects with EADDRINUSE,
 * with nothing left bound. A non-integer port (e.g. a listen-options object) throws a TypeError.
 * Resolves `{ port, servers, addresses(), close() }`.
 */
export async function listenLoopback(makeServer, port = 0, { attempts = 5 } = {}) {
  // A number, never a listen-options object: `listen({ host: "0.0.0.0" })` would ignore the host
  // we pass and bind wherever the object says.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(`loopback listen: port must be an integer 0-65535, got ${typeof port === "object" ? JSON.stringify(port) : String(port)}`);
  }
  // An explicit port another process already serves (or may serve) is taken, even where (macOS/BSD, libuv sets
  // SO_REUSEADDR) a loopback bind over that process's wildcard listener would succeed and shadow
  // it on loopback. Same EADDRINUSE the bind itself gives, so callers fall forward as before.
  if (port !== 0) {
    for (const host of LOOPBACK_HOSTS) if (await occupied(host, port)) throw inUse(port);
  }
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const v4 = makeServer();
    const actual = await bindOne(v4, port, LOOPBACK_HOSTS[0]);   // rejects (nothing bound) on error
    const servers = [v4];
    const v6 = makeServer();
    try {
      await bindOne(v6, actual, LOOPBACK_HOSTS[1]);
      servers.push(v6);
    } catch (e) {
      if (!IPV6_UNAVAILABLE.has(e?.code)) {
        await closeOne(v4);
        lastError = e;
        if (e?.code === "EADDRINUSE" && port === 0) continue;  // OS-picked port busy on ::1: pick again
        throw e;
      }
      // No IPv6 on this host: 127.0.0.1 alone is the whole loopback surface.
    }
    return {
      port: actual,
      servers,
      addresses: () => servers.map((s) => s.address()).filter(Boolean),
      close: () => Promise.all(servers.map(closeOne)).then(() => {}),
    };
  }
  throw lastError;
}
