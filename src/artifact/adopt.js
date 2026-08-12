// adopt.js — re-register project memberships from doc-side breadcrumbs (DES-PROJECT-001 §7).
//
// The control store (crew's core.db) is the authority for "which docs are in which project";
// the `project.json` breadcrumb beside each versions.json is the advisory doc-side copy. After a
// control-store loss — or on a new machine with synced doc dirs — `wicked-interactive adopt`
// walks the docs root, finds breadcrumbs, and re-POSTs each membership. Crew's attach is
// idempotent, so adopting an already-registered doc is a no-op (200), not a duplicate.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadBreadcrumb, registerDocMembership, resolveCrewApi, writeBreadcrumb } from "../service/project.js";

const HELP = `wicked-interactive adopt — re-register doc→project memberships from breadcrumbs

Usage:
  wicked-interactive adopt [--root <docs-dir>] [--crew-api <base-url>]

Scans <root> (default ~/wicked-interactive/docs) for doc dirs carrying a project.json
breadcrumb and re-registers each as an interactive.doc member of its project on the crew
daemon (idempotent). Docs without a breadcrumb are untouched.
`;

export async function runAdopt(args) {
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const root = args.root ? resolve(String(args.root)) : resolve(homedir(), "wicked-interactive", "docs");
  const crewApi = args["crew-api"] ? String(args["crew-api"]) : resolveCrewApi();
  if (!existsSync(root)) {
    console.error(`adopt: docs root not found: ${root}`);
    return 1;
  }

  let found = 0;
  let adopted = 0;
  let failed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    // Only real docs (versions.json) with a binding (project.json) are adoptable.
    if (!existsSync(join(dir, "versions.json"))) continue;
    const crumb = loadBreadcrumb(dir);
    if (!crumb || typeof crumb.project_id !== "string" || !crumb.project_id) continue;
    found += 1;
    try {
      await registerDocMembership(crewApi, crumb.project_id, entry.name, {
        title: entry.name,
        readopted: true,
      });
      // Refresh the breadcrumb's daemon coordinates (the project id/name stay as recorded —
      // the table is the authority on those; a rename shows on the next successful bind).
      writeBreadcrumb(dir, { ...crumb, crew_api: crewApi, attached_at: new Date().toISOString() });
      adopted += 1;
      console.log(`adopted: ${entry.name} -> ${crumb.project_id}`);
    } catch (e) {
      failed += 1;
      console.error(`failed:  ${entry.name} -> ${crumb.project_id}: ${e.message}`);
    }
  }
  console.log(`adopt: ${adopted}/${found} membership(s) re-registered${failed ? `, ${failed} failed` : ""} (root: ${root})`);
  return failed > 0 ? 1 : 0;
}
