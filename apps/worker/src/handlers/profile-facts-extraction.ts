import type PgBoss from "pg-boss";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  buildAiRunRecord,
  getAiProviders,
  PROFILE_FACTS_PIPELINE_VERSION,
  PROFILE_FACTS_PROMPT_VERSION,
  profileFactsModel,
} from "@ustal/ai";
import { getDb, resolveProfileFactSlots, schema } from "@ustal/database";
import { profileFactSlotKey, profileFactsExtractionSchema, type ProfileFactType, type ProfileFactValue } from "@ustal/validation";
import { MAX_PROFILE_FACTS_SOURCE_CHARS, validateExtractedFacts } from "../profile-facts.js";

export interface ProfileFactsJobData {
  userId: string;
  sourceInputId: string;
}
export type ProfileFactsResult =
  | { status: "succeeded"; extractionId: string; facts: number; rejected: number; reused?: true }
  | { status: "failed" | "skipped"; extractionId?: string; reason: string };

const technical = (error: unknown) => {
  const e = error instanceof Error ? error : new Error(String(error));
  const code = (e as { code?: unknown; status?: unknown }).code ?? (e as { status?: unknown }).status;
  // Name/code only: provider messages and validation diagnostics may quote the user's text.
  return `${e.name}${typeof code === "string" || typeof code === "number" ? `:${code}` : ""}`.slice(0, 300);
};

/**
 * Phase 1 profile_facts — SHADOW MODE. Extracts structured facts from ONE confirmed profile input.
 *
 * Independent of handleProfileExtraction (capability profile / matching): its failure never touches
 * profile_source_inputs, capability_profiles, matching_* or skills/resources, and nothing reads
 * profile_facts in matching/feed/public profile. Failures are recorded in profile_fact_extractions
 * (status=failed, technical code only) and are retried by `reprocess-facts-cli.ts`, not by throwing.
 * Idempotent per (source input, pipeline/prompt/model version).
 */
export async function handleProfileFactsExtraction(
  job: PgBoss.Job<ProfileFactsJobData>,
): Promise<ProfileFactsResult> {
  const db = getDb();
  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  // Ownership is taken from the stored input, never trusted from the job payload.
  if (!input) return { status: "skipped", reason: "source_not_found" };
  if (input.userId !== job.data.userId) {
    console.error(JSON.stringify({ event: "profile_facts_owner_mismatch", sourceInputId: input.id }));
    return { status: "skipped", reason: "owner_mismatch" };
  }
  if (input.status !== "confirmed") return { status: "skipped", reason: "source_not_confirmed" };
  // Phase 2A: a message the owner withdrew from the facts layer is never (re-)extracted.
  if (input.revokedAt) return { status: "skipped", reason: "source_revoked" };

  const version = {
    pipelineVersion: PROFILE_FACTS_PIPELINE_VERSION,
    promptVersion: PROFILE_FACTS_PROMPT_VERSION,
    model: profileFactsModel(),
  };
  await db.insert(schema.profileFactExtractions)
    .values({ userId: input.userId, sourceInputId: input.id, ...version })
    .onConflictDoNothing();
  const extraction = await db.query.profileFactExtractions.findFirst({
    where: and(
      eq(schema.profileFactExtractions.sourceInputId, input.id),
      eq(schema.profileFactExtractions.pipelineVersion, version.pipelineVersion),
      eq(schema.profileFactExtractions.promptVersion, version.promptVersion),
      eq(schema.profileFactExtractions.model, version.model),
    ),
  });
  if (!extraction) throw new Error("profile_fact_extractions row missing");
  if (extraction.status === "succeeded")
    return { status: "succeeded", extractionId: extraction.id, facts: extraction.factsCount ?? 0, rejected: extraction.rejectedCount ?? 0, reused: true };

  const finish = async (status: "failed" | "skipped", error: string) => {
    await db.update(schema.profileFactExtractions)
      .set({ status, error, completedAt: new Date() })
      .where(eq(schema.profileFactExtractions.id, extraction.id));
    return { status, extractionId: extraction.id, reason: error } as const;
  };
  // Same source text as the capability-profile pipeline uses for this input; raw text is never modified.
  const text = input.transcriptCorrected ?? input.transcript ?? input.rawText;
  if (!text?.trim()) return finish("skipped", "empty_source");
  if (text.length > MAX_PROFILE_FACTS_SOURCE_CHARS) return finish("skipped", "source_too_large");

  await db.update(schema.profileFactExtractions)
    .set({ attempts: sql`${schema.profileFactExtractions.attempts} + 1`, status: "pending", error: null })
    .where(eq(schema.profileFactExtractions.id, extraction.id));

  const meta = { operationType: "profile_facts_extraction", traceId: job.id, promptVersion: version.promptVersion, schemaVersion: "v1" };
  const started = new Date();
  let facts;
  try {
    const result = await getAiProviders().extraction.extractProfileFacts({ text }, meta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { result }));
    facts = profileFactsExtractionSchema.parse(result.data).facts;
  } catch (error) {
    await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { error: new Error(technical(error)) }));
    console.error(JSON.stringify({ event: "profile_facts_extraction_failed", sourceInputId: input.id, extractionId: extraction.id, error: technical(error) }));
    return finish("failed", technical(error));
  }

  const { accepted, rejected } = validateExtractedFacts(text, facts);
  const rejectedCount = Object.values(rejected).reduce((a, b) => a + (b ?? 0), 0);
  if (rejectedCount)
    console.info(JSON.stringify({ event: "profile_facts_rejected", sourceInputId: input.id, extractionId: extraction.id, rejected }));

  return db.transaction(async (tx) => {
    // Serialises fact writes per user (key 2: independent of the profile-extraction lock, key 0).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 2))`);
    const [current] = await tx.select().from(schema.profileFactExtractions)
      .where(eq(schema.profileFactExtractions.id, extraction.id)).for("update");
    if (current?.status === "succeeded")
      return { status: "succeeded" as const, extractionId: extraction.id, facts: current.factsCount ?? 0, rejected: current.rejectedCount ?? 0, reused: true as const };

    // The owner may have withdrawn the message while the model was running.
    const [source] = await tx.select({ revokedAt: schema.profileSourceInputs.revokedAt })
      .from(schema.profileSourceInputs).where(eq(schema.profileSourceInputs.id, input.id));
    if (source?.revokedAt) {
      await tx.update(schema.profileFactExtractions).set({ status: "skipped", error: "source_revoked", completedAt: new Date() })
        .where(eq(schema.profileFactExtractions.id, extraction.id));
      return { status: "skipped" as const, extractionId: extraction.id, reason: "source_revoked" };
    }

    // Re-extraction of this input by a newer pipeline version (Phase 2A precedence):
    // - AI-only facts of the older version are `replaced` (kept for audit); the new fact of the same slot
    //   links back (replaces_fact_id) and inherits visibility;
    // - facts the owner confirmed or corrected are NEVER replaced: the new AI fact of that slot is stored
    //   but can only be `superseded` by the user's fact (corrected > confirmed > AI);
    // - a slot the owner revoked stays revoked: the new AI fact of that slot is stored as revoked too, so a
    //   revoked fact never comes back without a new user message.
    // The slot of an older fact is taken from its AI value, so a correction that renamed the label still
    // shadows the AI re-extraction of the original wording.
    const previous = await tx.select().from(schema.profileFacts).where(and(
      eq(schema.profileFacts.sourceInputId, input.id),
      ne(schema.profileFacts.extractionId, extraction.id),
      ne(schema.profileFacts.status, "replaced"),
    ));
    const aiSlot = (p: (typeof previous)[number]) => profileFactSlotKey(p.factType as ProfileFactType, p.value as ProfileFactValue);
    const aiOnly = previous.filter((p) => !p.userDecision);
    const revokedSlots = new Map(previous.filter((p) => p.userDecision === "revoked").map((p) => [aiSlot(p), p]));
    const decidedSlots = new Map(previous.filter((p) => p.userDecision === "confirmed" || p.userDecision === "corrected").map((p) => [aiSlot(p), p]));
    if (aiOnly.length)
      await tx.update(schema.profileFacts).set({ status: "replaced", supersededByFactId: null, updatedAt: new Date() })
        .where(inArray(schema.profileFacts.id, aiOnly.map((p) => p.id)));
    const aiOnlyBySlot = new Map(aiOnly.map((p) => [p.slotKey, p]));
    const now = new Date();
    if (accepted.length)
      await tx.insert(schema.profileFacts).values(accepted.map((f) => {
        const revoked = revokedSlots.get(f.slotKey);
        const decided = decidedSlots.get(f.slotKey);
        const predecessor = aiOnlyBySlot.get(f.slotKey);
        return {
          userId: input.userId,
          sourceInputId: input.id,
          extractionId: extraction.id,
          factType: f.factType,
          // A re-extraction shadowed by the owner's fact joins that fact's (possibly renamed) slot, where
          // precedence keeps the user's version active.
          slotKey: decided && !revoked ? decided.slotKey : f.slotKey,
          value: f.value,
          evidence: f.evidence,
          confidence: String(f.confidence),
          assertion: f.assertion,
          // provisional "superseded"; resolveProfileFactSlots decides active vs superseded below
          status: revoked ? "revoked" : "superseded",
          userDecision: revoked ? "revoked" : null,
          decidedAt: revoked ? now : null,
          supersededByFactId: decided && !revoked ? decided.id : null,
          replacesFactId: revoked?.id ?? predecessor?.id ?? null,
          visibility: predecessor?.visibility ?? "private",
        };
      }));
    await resolveProfileFactSlots(tx, input.userId, [...accepted.map((f) => f.slotKey), ...previous.map((p) => p.slotKey)]);
    await tx.update(schema.profileFactExtractions)
      .set({ status: "succeeded", factsCount: accepted.length, rejectedCount, error: null, completedAt: new Date() })
      .where(eq(schema.profileFactExtractions.id, extraction.id));
    return { status: "succeeded" as const, extractionId: extraction.id, facts: accepted.length, rejected: rejectedCount };
  });
}
