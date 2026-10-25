import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, "release-baseline.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const problems = [];
if (root.replaceAll("\\", "/").toLowerCase() !== manifest.repository.replaceAll("\\", "/").toLowerCase()) problems.push("Repository path differs; agree the destination with the integrator");
if (relative(root, process.cwd()).startsWith("..")) problems.push("Run inside the canonical repository");
if (git("branch", "--show-current") !== manifest.branch) problems.push("Branch differs");
if (git("rev-parse", "HEAD") !== manifest.baseCommit) problems.push("HEAD differs; request a new baseline");
for (const [name, hash] of Object.entries(manifest.files)) {
  const path = resolve(root, name);
  if (relative(root, path).startsWith("..") || !existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) problems.push(`Content differs: ${name}`);
}
const current = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
for (const name of current) if (name !== "release-baseline.json" && !(name in manifest.files)) problems.push(`Unexpected file: ${name}`);
if (problems.length) {
  console.error("STOP: baseline mismatch\n" + problems.join("\n"));
  process.exitCode = 1;
} else console.log(`PASS ${manifest.branch} base ${manifest.baseCommit}; exact uncommitted snapshot verified`);
