import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, loadCurrentProfile, loadProfileLineage, resolveProfileFactSlots, schema } from "@ustal/database";
import { getBoss, JOB_TYPES } from "@ustal/queue";

/**
 * Revoke one of MY profile messages (2026-09-28). ONE semantics everywhere:
 *  1. facts derived from it are revoked (profile_facts, as in Phase 2A);
 *  2. it never takes part in any future AI-profile build (extraction/reprocess skip it);
 *  3. if the current AI profile contains it, that version immediately leaves matching and the feed
 *     (status rebuild_pending: matching/feed only read status='applied') and a worker job rebuilds the
 *     profile from the remaining messages through the normal pipeline, then rematches;
 *  4. pending drafts built on top of it are invalidated (non-revoked ones are re-extracted by the job).
 * Raw text stays in profile_source_inputs only as internal audit (existing retention policy).
 * Nothing is removed sentence-by-sentence from generated text.
 */
export type SourceRevokeResult = { profileRebuild: "pending" | "not_needed" };

const MUTABLE = ["active", "superseded"];

export async function revokeProfileSourceInput(userId: string, sourceInputId: string): Promise<SourceRevokeResult | null> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Same lock order as profile extraction/apply (key 0) and the facts layer (key 2).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 2))`);
    const [input] = await tx.select().from(schema.profileSourceInputs)
      .where(and(eq(schema.profileSourceInputs.id, sourceInputId), eq(schema.profileSourceInputs.userId, userId))).for("update");
    if (!input) return null;
    const now = new Date();
    if (!input.revokedAt)
      await tx.update(schema.profileSourceInputs).set({ revokedAt: now }).where(eq(schema.profileSourceInputs.id, input.id));

    const facts = await tx.select().from(schema.profileFacts).where(and(
      eq(schema.profileFacts.sourceInputId, input.id), eq(schema.profileFacts.userId, userId),
      inArray(schema.profileFacts.status, MUTABLE),
    ));
    if (facts.length) {
      await tx.update(schema.profileFacts).set({ status: "revoked", userDecision: "revoked", userValue: null, supersededByFactId: null, decidedAt: now, updatedAt: now })
        .where(inArray(schema.profileFacts.id, facts.map((f) => f.id)));
      await resolveProfileFactSlots(tx, userId, facts.map((f) => f.slotKey));
    }

    const current = await loadCurrentProfile(tx, userId);
    let rebuild = current?.status === "rebuild_pending";
    if (current && !rebuild && (await loadProfileLineage(tx, current)).inputs.some((i) => i.revokedAt)) {
      await tx.update(schema.capabilityProfiles).set({ status: "rebuild_pending" }).where(eq(schema.capabilityProfiles.id, current.id));
      rebuild = true;
    }
    if (rebuild) {
      // Every pending draft was built on the profile text that contains the revoked message.
      await tx.update(schema.capabilityProfiles).set({ status: "invalidated" })
        .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "draft")));
      // Watermark: old feed rows hide at once and orders are re-run without the pending version.
      await tx.insert(schema.rematchRequests).values({ userId })
        .onConflictDoUpdate({ target: schema.rematchRequests.userId, set: { requestedAt: sql`now()`, cursor: null } });
    } else {
      // Pending drafts are cumulative too: another draft may contain this input.
      // Invalidate the pending chain; the dispatcher re-extracts active inputs.
      await tx.update(schema.capabilityProfiles).set({ status: "invalidated" })
        .where(and(eq(schema.capabilityProfiles.userId, userId),
          eq(schema.capabilityProfiles.status, "draft")));
    }
    return { profileRebuild: rebuild ? "pending" as const : "not_needed" as const };
  });
  if (result?.profileRebuild === "pending") await enqueueProfileRebuild(userId);
  return result;
}

/** Best effort: the worker tick re-dispatches any profile left in rebuild_pending. */
async function enqueueProfileRebuild(userId: string) {
  try {
    await (await getBoss()).send(JOB_TYPES.PROFILE_REBUILD, { userId },
      { singletonKey: `profile-rebuild:${userId}`, retryLimit: 5, retryDelay: 30, retryBackoff: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "profile_rebuild_enqueue_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}
