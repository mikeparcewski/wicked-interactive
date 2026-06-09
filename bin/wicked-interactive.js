#!/usr/bin/env node
// wicked-interactive CLI — the one command a business user runs (INV-6).
//
//   wicked-interactive serve --root <docs-dir> [--port N]
//       Multi-document mode (ADR-0015). Hosts every workspace under <docs-dir>; new docs are
//       created from the UI. The control plane is wicked-bus (ADR-0019): the agent watches the
//       loop with `wicked-bus subscribe --filter '*@wicked-interactive'`, not a bespoke tail.

import { createMultiServer } from "../src/service/server.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd !== "serve" || !args.root) {
    console.error("usage: wicked-interactive serve --root <docs-dir> [--port N]");
    process.exit(1);
  }

  const port = args.port ? Number(args.port) : 4400;
  const svc = createMultiServer({ root: args.root });
  const actualPort = await svc.start(port);
  const base = `http://localhost:${actualPort}`;
  console.log(`wicked-interactive (multi-doc) serving ${args.root} on ${base}`);
  console.log(`  docs:   ${base}/api/docs`);
  console.log(`  open:   ${base}/?doc=<name>`);
  console.log(`  loop:   wicked-bus subscribe --plugin wi-agent --filter '*@wicked-interactive' --cursor-init latest`);

  const shutdown = async () => { await svc.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
