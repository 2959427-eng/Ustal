import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvedRetentionDays, parseRetentionPolicy, retentionCategories } from "./retention-policy.js";
const template = () => JSON.parse(readFileSync(new URL("../../../../docs/launch/retention-policy.template.json", import.meta.url), "utf8"));
describe("retention configuration (no runtime deletion)", () => {
  it("template separates all six categories without inventing deadlines", () => {
    const policy = parseRetentionPolicy(template());
    expect(Object.keys(policy.categories)).toEqual([...retentionCategories]);
    for (const category of retentionCategories) {
      expect(policy.categories[category].durationDays).toBeNull();
      expect(() => approvedRetentionDays(policy, category)).toThrow("not approved");
    }
  });
  it("a configured duration alone cannot authorize retention enforcement", () => {
    const input = template(); input.categories.backups.durationDays = 7;
    expect(() => approvedRetentionDays(parseRetentionPolicy(input), "backups")).toThrow("not approved");
    input.categories.backups.approved = true;
    expect(() => parseRetentionPolicy(input)).toThrow("approval required");
    input.categories.backups.approvalReference = "test-only-owner-decision";
    expect(approvedRetentionDays(parseRetentionPolicy(input), "backups")).toBe(7);
    expect(() => approvedRetentionDays(parseRetentionPolicy(input), "reviews_ratings")).toThrow();
  });
  it("rejects zero, negative, fractional, malformed or incomplete rules", () => {
    for (const duration of [0,-1,0.5,"30",undefined]) {
      const input = template(); input.categories.backups.durationDays = duration;
      expect(() => parseRetentionPolicy(input)).toThrow();
    }
    const input = template(); delete input.categories.ai_profile_derived_data;
    expect(() => parseRetentionPolicy(input)).toThrow();
  });
});
