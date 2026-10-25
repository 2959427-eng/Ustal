/** Configuration boundary only. No expiry scheduler, SQL delete or backup pruning. */
export const retentionCategories = ["deleted_account_personal_data", "completed_orders_history", "reviews_ratings", "security_audit_logs", "backups", "ai_profile_derived_data"] as const;
export type RetentionCategory = typeof retentionCategories[number];
export type RetentionRule = { approved: boolean; durationDays: number | null; approvalReference: string | null };
export type RetentionPolicy = { version: 1; categories: Record<RetentionCategory, RetentionRule> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function parseRetentionPolicy(input: unknown): RetentionPolicy {
  if (!record(input) || input.version !== 1 || !record(input.categories)) throw new Error("Invalid retention policy");
  const categories = input.categories;
  if (Object.keys(categories).length !== retentionCategories.length || Object.keys(categories).some(k => !(retentionCategories as readonly string[]).includes(k))) throw new Error("Invalid retention categories");
  const result = {} as Record<RetentionCategory, RetentionRule>;
  for (const key of retentionCategories) {
    const rule = categories[key];
    if (!record(rule) || typeof rule.approved !== "boolean" || Object.keys(rule).some(k => !["approved", "durationDays", "approvalReference"].includes(k))) throw new Error("Invalid retention rule");
    if (rule.durationDays !== null && (typeof rule.durationDays !== "number" || !Number.isSafeInteger(rule.durationDays) || rule.durationDays < 1)) throw new Error("Invalid retention duration");
    if (rule.approvalReference !== null && (typeof rule.approvalReference !== "string" || !rule.approvalReference.trim() || rule.approvalReference.includes("TBD"))) throw new Error("Invalid retention approval reference");
    if (rule.approved && (rule.durationDays === null || !rule.approvalReference)) throw new Error("Retention approval required");
    result[key] = { approved: rule.approved, durationDays: rule.durationDays as number | null, approvalReference: rule.approvalReference as string | null };
  }
  return { version: 1, categories: result };
}
/** Future consumers must request an approved rule explicitly. Never infer zero/default days. */
export function approvedRetentionDays(policy: RetentionPolicy, category: RetentionCategory): number {
  const rule = parseRetentionPolicy(policy).categories[category];
  if (!rule.approved || rule.durationDays === null) throw new Error("Retention decision not approved");
  return rule.durationDays;
}
