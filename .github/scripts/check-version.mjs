// check-version.mjs — fail if the plugin's version fields drift, or (on a vX.Y.Z tag) if they
// don't match the tag. This is the guard against the recurring bug where marketplace.json
// silently lags behind a release. Runs in CI and via `npm run check:version`.
import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const fields = {
  "package.json": read("package.json").version,
  ".claude-plugin/plugin.json": read(".claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json": read(".claude-plugin/marketplace.json").plugins?.[0]?.version,
};

const distinct = [...new Set(Object.values(fields))];
if (distinct.length !== 1 || !distinct[0]) {
  console.error("✗ Plugin version fields are out of sync:");
  for (const [f, v] of Object.entries(fields)) console.error(`    ${f}: ${v ?? "(missing)"}`);
  console.error("  Fix with `npm version <x.y.z>` (it syncs all three).");
  process.exit(1);
}

let line = `✓ Plugin version ${distinct[0]} is consistent across package.json, plugin.json, and marketplace.json`;

const tag = (process.env.GITHUB_REF || "").match(/^refs\/tags\/v(.+)$/);
if (tag && tag[1] !== distinct[0]) {
  console.error(`✗ Tag v${tag[1]} does not match the manifest version ${distinct[0]}.`);
  console.error(`  Bump the manifests first (\`npm version ${tag[1]}\`), then tag.`);
  process.exit(1);
}
if (tag) line += ` and matches tag v${tag[1]}`;
console.log(line);
