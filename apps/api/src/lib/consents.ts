import { createHash } from "node:crypto";
import { getSql } from "@ustal/database";

// Infrastructure only: this module does NOT authorize or guard actual outbound AI calls yet.
export function disclosureHash(content: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    throw new Error("Disclosure must contain JSON values only");
  };
  return createHash("sha256").update(canonical(content), "utf8").digest("hex");
}

export class ConsentError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type ConsentDecision = { policyId: string; policyHash: string; decision: "grant" | "revoke"; expectedRevision: number };

export async function readConsents(userId: string) {
  return getSql().begin(async tx => {
    // Serialize with deletion so an authenticated request cannot read evidence after delete commits.
    const [user] = await tx`SELECT status FROM users WHERE id=${userId} FOR SHARE`;
    if (user?.status !== "active") throw new ConsentError(401, "unauthorized");
    const [revision] = await tx`SELECT coalesce(max(seq), 0)::integer AS revision FROM consent_decisions WHERE user_id=${userId}`;
    const policies = await tx`SELECT id, purpose, version, content, content_hash AS "policyHash", status FROM consent_disclosures WHERE is_current ORDER BY purpose`;
    const decisions = await tx`SELECT DISTINCT ON (p.purpose) p.purpose, d.policy_id AS "policyId", d.policy_hash AS "policyHash",
      d.decision, d.seq, d.actor_user_id AS "actorUserId", d.decided_at AS "decidedAt",
      (d.decision='grant' AND p.status='approved' AND p.is_current) AS effective
      FROM consent_decisions d JOIN consent_disclosures p ON p.id=d.policy_id
      WHERE d.user_id=${userId} ORDER BY p.purpose, d.seq DESC`;
    return { revision: revision!.revision as number, policies, decisions, outboundEnforcement: false };
  });
}

export async function decideConsent(userId: string, input: ConsentDecision) {
  return getSql().begin(async tx => {
    // Same lock deletion uses; no grant can commit after deleted-user transition.
    const [user] = await tx`SELECT status FROM users WHERE id=${userId} FOR UPDATE`;
    if (user?.status !== "active") throw new ConsentError(401, "unauthorized");
    const [revision] = await tx`SELECT coalesce(max(seq), 0)::integer AS revision FROM consent_decisions WHERE user_id=${userId}`;
    const currentRevision = revision!.revision as number;
    if (input.expectedRevision !== currentRevision) throw new ConsentError(409, "consent_revision_conflict");
    const [policy] = await tx`SELECT * FROM consent_disclosures WHERE id=${input.policyId} FOR SHARE`;
    if (!policy || policy.content_hash !== input.policyHash || disclosureHash(policy.content) !== input.policyHash)
      throw new ConsentError(409, "consent_policy_changed");
    if (input.decision === "grant" && (policy.status !== "approved" || !policy.is_current))
      throw new ConsentError(409, "consent_policy_not_approved_current");
    const [latest] = await tx`SELECT d.* FROM consent_decisions d JOIN consent_disclosures p ON p.id=d.policy_id
      WHERE d.user_id=${userId} AND p.purpose=${policy.purpose} ORDER BY d.seq DESC LIMIT 1`;
    if (latest?.decision === input.decision && latest.policy_id === input.policyId && latest.policy_hash === input.policyHash)
      return { changed: false, revision: currentRevision };
    const next = currentRevision + 1;
    await tx`INSERT INTO consent_decisions (user_id, actor_user_id, seq, policy_id, policy_hash, decision)
      VALUES (${userId}, ${userId}, ${next}, ${input.policyId}, ${input.policyHash}, ${input.decision})`;
    return { changed: true, revision: next };
  });
}
