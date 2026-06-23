#!/usr/bin/env node
/**
 * Build, validate, and publish (or dry-run) to ClawHub.
 * Requires: clawhub login (clawhub whoami), @identyclaw publisher access.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    stdio: "inherit",
    encoding: "utf8",
    ...opts
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  if (!pkg.version) {
    console.error("package.json missing version");
    process.exit(1);
  }
  return pkg.version;
}

run("npm", ["run", "prepare:publish"]);

const version = readPackageVersion();

function readChangelogSummary(ver) {
  const changelog = readFileSync(join(pluginRoot, "CHANGELOG.md"), "utf8");
  const escaped = ver.replace(/\./g, "\\.");
  const section = changelog.match(
    new RegExp(`## \\[?${escaped}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`)
  );
  if (!section) {
    return `v${ver}`;
  }
  const bullets = section[1]
    .split("\n")
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.slice(2).trim())
    .join("; ");
  return bullets ? `v${ver}: ${bullets}` : `v${ver}`;
}

const publishArgs = [
  "package",
  "publish",
  ".",
  "--owner",
  "identyclaw",
  "--family",
  "code-plugin",
  "--version",
  version,
  "--changelog",
  readChangelogSummary(version)
];

if (process.env.GITHUB_REPOSITORY) {
  publishArgs.push("--source-repo", process.env.GITHUB_REPOSITORY);
}
if (process.env.GITHUB_SHA) {
  publishArgs.push("--source-commit", process.env.GITHUB_SHA);
}
if (process.env.GITHUB_REF_NAME) {
  publishArgs.push("--source-ref", process.env.GITHUB_REF_NAME);
}

if (dryRun) publishArgs.push("--dry-run");

const clawhubArgs = ["--yes", "clawhub"];
if (process.env.CLAWHUB_TOKEN || process.env.CI) {
  clawhubArgs.push("--no-input");
}

const clawhub = spawnSync("npx", [...clawhubArgs, ...publishArgs], {
  cwd: pluginRoot,
  stdio: "inherit"
});
process.exit(clawhub.status ?? 1);
