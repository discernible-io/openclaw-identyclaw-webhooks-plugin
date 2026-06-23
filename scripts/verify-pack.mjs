#!/usr/bin/env node
/**
 * Ensure npm pack includes files required for ClawHub / OpenClaw install.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(pluginRoot, "openclaw.plugin.json"), "utf8"));
if (manifest.version && manifest.version !== pkg.version) {
  console.error(
    `[verify-pack] openclaw.plugin.json version (${manifest.version}) must match package.json (${pkg.version})`
  );
  process.exit(1);
}

const pack = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts"], {
  cwd: pluginRoot,
  encoding: "utf8"
});
if (pack.status !== 0) {
  console.error(pack.stderr || pack.stdout);
  process.exit(pack.status ?? 1);
}

const output = `${pack.stdout}\n${pack.stderr}`;
const required = [
  "dist/index.js",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
  "LICENSE"
];
const forbidden = ["tests/", "src/"];

for (const entry of required) {
  if (!output.includes(entry)) {
    console.error(`[verify-pack] missing from npm pack: ${entry}`);
    console.error("Add required paths to package.json files.");
    process.exit(1);
  }
}

for (const entry of forbidden) {
  if (output.includes(entry)) {
    console.error(`[verify-pack] forbidden path in npm pack: ${entry}`);
    process.exit(1);
  }
}

console.log("[verify-pack] OK — publish tarball includes required plugin files");
