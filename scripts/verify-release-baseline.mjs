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
const head = git("rev-parse", "HEAD");
if (head !== manifest.baseCommit) {
  // A snapshot cannot contain the SHA of the commit that will contain it.
  // Accept its single future commit only if the anchored parent, committed
  // manifest and every file below still match the exact approved snapshot.
  try {
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    if (parents.length !== 2 || parents[1] !== manifest.baseCommit) throw Error("parent mismatch");
    const committed = execFileSync("git", ["show", "HEAD:release-baseline.json"], { cwd: root, encoding: "utf8" });
    if (committed.replaceAll("\r\n", "\n") !== readFileSync(resolve(root, "release-baseline.json"), "utf8").replaceAll("\r\n", "\n")) throw Error("manifest mismatch");
  } catch { problems.push("HEAD differs from the anchored base or its exact snapshot commit; request a new baseline"); }
}
if (manifest.hashMode !== "sha256-lf-text") problems.push("Unknown baseline hash mode");
const contentHash = path => {
  const bytes = readFileSync(path);
  const normalized = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  return createHash("sha256").update(normalized).digest("hex");
};
for (const [name, hash] of Object.entries(manifest.files)) {
  const path = resolve(root, name);
  if (relative(root, path).startsWith("..") || !existsSync(path) || contentHash(path) !== hash) problems.push(`Content differs: ${name}`);
}
const current = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).filter(name => existsSync(resolve(root, name)));
for (const name of current) if (name !== "release-baseline.json" && !(name in manifest.files)) problems.push(`Unexpected file: ${name}`);
if (problems.length) {
  console.error("STOP: baseline mismatch\n" + problems.join("\n"));
  process.exitCode = 1;
} else console.log(`PASS ${manifest.branch} HEAD ${head}; exact snapshot anchored at ${manifest.baseCommit} verified`);

