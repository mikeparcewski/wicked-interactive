#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve --dir <workspace> [--port N]
//       Serve an existing document workspace and watch it for feedback.
//
//   wicked-interactive serve --dir <workspace> --html <file> [--port N]
//       Initialise the workspace from an HTML draft (instrumenting it), then serve.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/service/server.js";
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
    console.error("usage: wicked-interactive serve --dir <workspace> [--html <file>] [--port N]");
    process.exit(1);
  }
  if (!args.dir) {
    console.error("error: --dir <workspace> is required");
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
  const port = await svc.start(args.port ? Number(args.port) : 4400);
  console.log(`wicked-interactive serving ${dir} on http://localhost:${port}`);
  console.log(`  head:   http://localhost:${port}/doc`);
  console.log(`  events: http://localhost:${port}/events`);

  const shutdown = async () => { await svc.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
