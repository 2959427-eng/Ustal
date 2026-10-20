import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 1 SHADOW guard: profile_facts must not be read by matching, feed, public profile or any existing
 * API. The only allowed code references are the extraction handler, its pure rules, the reprocess tool,
 * the worker registration, the API enqueue helper and tests.
 */
const root = join(__dirname, "../../..");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === "node_modules" ? [] : files(p)) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
});
const allowed = [
  "apps/worker/src/handlers/profile-facts-extraction.ts",
  "apps/worker/src/profile-facts.ts",
  "apps/worker/src/reprocess-facts.ts",
  "apps/worker/src/reprocess-facts-cli.ts",
  "apps/worker/src/index.ts",
  "apps/worker/src/worker-consent.ts", // job kind and source metadata only
  "packages/database/src/consent-blocked-work.ts", // job kind metadata only
  "apps/api/src/lib/profile-facts.ts",
  "apps/api/src/routes/profile.ts", // enqueue only (asserted below)
  "packages/database/src/schema.ts",
  "packages/database/src/profile-facts.ts", // shared slot resolution
  "packages/database/src/index.ts",
  "apps/api/src/routes/profile-facts.ts", // Phase 2A owner-only API
  "apps/api/src/app.ts", // registers the owner-only routes
  "apps/api/src/lib/source-revoke.ts", // owner revoke: marks the message's facts revoked (never reads them for matching)
  "apps/api/src/lib/account-deletion.ts", // DELETE /me: deletes the owner's facts (never reads them)
  "packages/validation/src/profile-facts.ts",
  "packages/validation/src/index.ts",
  "packages/ai/src/index.ts",
  "packages/ai/src/types.ts",
  "packages/ai/src/providers/openai.ts",
  "packages/ai/src/providers/mock.ts",
  "packages/queue/src/index.ts",
  "packages/config/src/env.ts", // PROFILE_FACTS_EXTRACTION flag
];
const pattern = /profileFacts|profile_facts|profileFactExtractions|profile_fact_extractions|ProfileFacts|PROFILE_FACTS/;

describe("profile_facts shadow isolation", () => {
  it("no matching / feed / users / other runtime code references profile_facts", () => {
    const offenders = ["apps/api/src", "apps/worker/src", "packages"].flatMap((d) => files(join(root, d)))
      .map((p) => p.slice(root.length + 1).replace(/\\/g, "/"))
      .filter((p) => !p.includes("/migrations/") && !allowed.includes(p) && pattern.test(readFileSync(join(root, p), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("consent metadata never reads shadow fact values", () => {
    for (const p of ["apps/worker/src/worker-consent.ts", "packages/database/src/consent-blocked-work.ts"])
      expect(readFileSync(join(root,p),"utf8")).not.toMatch(/schema\.profileFacts|schema\.profileFactExtractions|from\s+profile_facts\b|from\s+profile_fact_extractions\b/i);
  });
  it("the profile route only enqueues the job; it never selects facts", () => {
    const src = readFileSync(join(root, "apps/api/src/routes/profile.ts"), "utf8");
    expect(src).not.toMatch(/schema\.profileFacts|schema\.profileFactExtractions/);
  });
  it("matching code never mentions facts", () => {
    for (const p of ["apps/worker/src/handlers/matching-run.ts", "apps/worker/src/semantic.ts", "apps/worker/src/profile-rebuild.ts", "packages/matching/src/semantic.ts", "apps/api/src/routes/feed.ts", "apps/api/src/routes/users.ts"])
      expect(readFileSync(join(root, p), "utf8")).not.toMatch(pattern);
  });
});
