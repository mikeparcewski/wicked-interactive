// sync-plugin-version.mjs — make the plugin manifests match package.json's version.
// Runs as the npm `version` lifecycle hook, so `npm version <x>` bumps all three at once
// (package.json + .claude-plugin/plugin.json + .claude-plugin/marketplace.json). This is the
// recurring drift we keep hitting — marketplace.json silently lagging behind a release.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function setVersion(path, mutate) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  mutate(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${path} -> ${version}`);
}

console.log(`Syncing plugin manifests to ${version}`);
setVersion(".claude-plugin/plugin.json", (j) => { j.version = version; });
setVersion(".claude-plugin/marketplace.json", (j) => {
  if (!j.plugins?.[0]) throw new Error("marketplace.json has no plugins[0] to version");
  j.plugins[0].version = version;
});
