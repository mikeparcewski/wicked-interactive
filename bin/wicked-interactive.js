#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve --root <docs-dir> [--port N]
//       Multi-document mode (ADR-0015). Hosts every workspace under <docs-dir>;
//       new docs are created from the UI ("New document" modal). Preferred.
//
//   wicked-interactive serve --dir <workspace> [--html <file>] [--port N]
//       Legacy single-document mode. Workspace must exist; --html seeds _v0.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, createMultiServer } from "../src/service/server.js";
import { initWorkspace } from "../src/service/workspace.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== "serve") {
    console.error("usage: wicked-interactive serve { --root <docs-dir> | --dir <workspace> [--html <file>] } [--port N]");
    process.exit(1);
  }

  const port = args.port ? Number(args.port) : 4400;

  if (args.root) {
    const svc = createMultiServer({ root: args.root });
    const actualPort = await svc.start(port);
    console.log(`wicked-interactive (multi-doc) serving ${args.root} on http://localhost:${actualPort}`);
    console.log(`  docs:   http://localhost:${actualPort}/api/docs`);
    console.log(`  open:   http://localhost:${actualPort}/?doc=<name>`);
    const shutdown = async () => { await svc.stop(); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (!args.dir) {
    console.error("error: pass --root <docs-dir> (multi-doc) or --dir <workspace> (legacy)");
    process.exit(1);
  }
  const dir = args.dir;
  if (!existsSync(join(dir, "versions.json"))) {
    if (!args.html) {
      console.error(`error: workspace ${dir} is not initialised; pass --html <file> to seed it`);
      process.exit(1);
    }
    initWorkspace(dir, readFileSync(args.html, "utf-8"));
    console.log(`initialised workspace at ${dir} from ${args.html}`);
  }
  const svc = createServer({ dir, documentId: dir });
  const actualPort = await svc.start(port);
  console.log(`wicked-interactive (single-doc) serving ${dir} on http://localhost:${actualPort}`);
  console.log(`  head:   http://localhost:${actualPort}/doc`);
  console.log(`  events: http://localhost:${actualPort}/events`);
  const shutdown = async () => { await svc.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
