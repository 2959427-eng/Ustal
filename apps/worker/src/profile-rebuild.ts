import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import {
  getDb,
  loadCurrentProfile,
  loadInputsToReextract,
  loadProfileLineage,
  PROFILE_SOURCE_SEPARATOR,
  schema,
} from "@ustal/database";
import { getBoss, JOB_TYPES, profileExtractionJobOptions } from "@ustal/queue";
import { capabilityExtractionResultSchema } from "@ustal/validation";
import { persistDocument, prepareProfileFromMessages, requestRematch } from "./semantic.js";
import { loadDecisions, scheduleDecisions } from "./profile-decisions.js";

/**
 * Source revoke lifecycle (2026-09-28). A revoked profile_source_input must not stay in the AI profile.
 * The profile is NOT edited sentence by sentence: it is rebuilt by the normal AI pipeline
 * (extractCapabilityProfile -> prepareDocument/normalizeMatching -> persistDocument -> embedding) from
 * the raw text of the remaining non-revoked messages of its lineage, as a new applied version. Nothing
 * is carried forward from the old version. Matching then recalculates through rematch_requests.
 *
 * Idempotent and safe to call anywhere: without a revoked message in the current profile it is a no-op
 * that makes no AI calls (users without revoked inputs keep exactly the current behaviour).
 */
export type RebuildResult =
  | { action: "noop" }
  | { action: "cleared"; previousProfileId: string }
  | { action: "rebuilt"; previousProfileId: string; profileId: string; profileVersion: number; inputs: number };

export async function rebuildProfileIfNeeded(userId: string, traceId: string = randomUUID()): Promise<RebuildResult> {
  const db = getDb();
  const base = await loadCurrentProfile(db, userId);
  if (!base) return { action: "noop" };
  if (base.status === "applied") {
    const [revoked] = await db.select({ id: schema.profileSourceInputs.id }).from(schema.profileSourceInputs)
      .where(and(eq(schema.profileSourceInputs.userId, userId), isNotNull(schema.profileSourceInputs.revokedAt))).limit(1);
    if (!revoked) return { action: "noop" };
  }
  const lineage = await loadProfileLineage(db, base);
  if (base.status === "applied" && !lineage.inputs.some((i) => i.revokedAt)) return { action: "noop" };
  const active = lineage.inputs.filter((i) => !i.revokedAt);

  let rebuilt: { summary: string; prepared: Awaited<ReturnType<typeof prepareProfileFromMessages>> } | undefined;
  if (active.length) {
    const source = active.map((i) => i.text).join(PROFILE_SOURCE_SEPARATOR);
    const ai = getAiProviders();
    const meta = { operationType: "profile_rebuild", traceId, promptVersion: "v1", schemaVersion: "v1" };
    const started = new Date();
    const result = await ai.extraction.extractCapabilityProfile({ text: source }, meta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { result }));
    const extracted = capabilityExtractionResultSchema.parse(result.data);
    // Сообщения воспроизводятся по одному — так же, как они применялись (обновление по одному сообщению).
    // Решения пользователя кнопкой (2026-10-17) переживают переборку: применяются между сообщениями по времени.
    const decisions = scheduleDecisions(await loadDecisions(db, userId), lineage.attributable ? active.map((i) => i.createdAt) : active.map(() => null));
    rebuilt = { summary: extracted.summary, prepared: await prepareProfileFromMessages(active.map((i) => i.text), extracted, traceId, decisions) };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const current = await loadCurrentProfile(tx, userId);
    if (current?.id !== base.id || current.status !== base.status)
      throw new Error("Profile changed during rebuild; retry against the current version");
    if (active.length) {
      const [revokedNow] = await tx.select({ id: schema.profileSourceInputs.id }).from(schema.profileSourceInputs)
        .where(and(inArray(schema.profileSourceInputs.id, active.map((i) => i.id)),
          isNotNull(schema.profileSourceInputs.revokedAt))).limit(1);
      if (revokedNow) throw new Error("Another message was revoked during rebuild; retry");
    }
    await tx.update(schema.capabilityProfiles).set({ status: "superseded" })
      .where(eq(schema.capabilityProfiles.id, base.id));
    // Drafts were built on top of the old profile text (which contains the revoked message).
    await tx.update(schema.capabilityProfiles).set({ status: "invalidated" })
      .where(and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "draft")));
    if (!rebuilt) {
      // No remaining message: the user has no AI profile (like before the first message).
      await requestRematch(tx, userId);
      return { action: "cleared" as const, previousProfileId: base.id };
    }
    const [latest] = await tx.select({ v: schema.capabilityProfiles.profileVersion }).from(schema.capabilityProfiles)
      .where(eq(schema.capabilityProfiles.userId, userId)).orderBy(desc(schema.capabilityProfiles.profileVersion)).limit(1);
    const [profile] = await tx.insert(schema.capabilityProfiles).values({
      userId,
      summary: rebuilt.summary,
      profileVersion: (latest?.v ?? 0) + 1,
      extractionVersion: rebuilt.prepared.processingVersion,
      embeddingModel: rebuilt.prepared.embeddingModel,
      sourceInputId: null,
      status: "applied",
    }).returning();
    if (!profile) throw new Error("Failed to create rebuilt profile");
    await persistDocument(tx, { profileId: profile.id }, rebuilt.prepared);
    await tx.insert(schema.profileEmbeddings).values({
      capabilityProfileId: profile.id,
      embedding: rebuilt.prepared.embedding,
      embeddingModel: rebuilt.prepared.embeddingModel,
    });
    await requestRematch(tx, userId);
    return { action: "rebuilt" as const, previousProfileId: base.id, profileId: profile.id,
      profileVersion: profile.profileVersion, inputs: active.length };
  });
}

type Enqueue = (userId: string, sourceInputId: string) => Promise<unknown>;
const enqueueExtraction: Enqueue = async (userId, sourceInputId) =>
  // Повторы и ключ одиночности — общие для всех задач разбора сообщения (QA 2026-10-14, дефект №2).
  (await getBoss()).send(JOB_TYPES.PROFILE_EXTRACTION, { userId, sourceInputId },
    profileExtractionJobOptions(sourceInputId));

/** Job: rebuild, then re-extract messages whose pending draft was invalidated (on top of the new profile). */
export async function handleProfileRebuild(job: PgBoss.Job<{ userId: string }>, enqueue: Enqueue = enqueueExtraction) {
  const result = await rebuildProfileIfNeeded(job.data.userId, job.id);
  const reextract = await loadInputsToReextract(getDb(), job.data.userId);
  for (const id of reextract) await enqueue(job.data.userId, id);
  console.log(JSON.stringify({ event: "profile_rebuild", action: result.action, reextracted: reextract.length }));
  return { ...result, reextracted: reextract.length };
}

export const enqueueProfileRebuild = async (userId: string) =>
  (await getBoss()).send(JOB_TYPES.PROFILE_REBUILD, { userId },
    { singletonKey: `profile-rebuild:${userId}`, retryLimit: 5, retryDelay: 30, retryBackoff: true });

/**
 * Durable safety net (worker tick): the API enqueues the rebuild best-effort; any profile still awaiting
 * a rebuild, or an invalidated draft whose message was not re-extracted yet, is picked up here.
 */
export async function dispatchProfileRebuilds(enqueue: (userId: string) => Promise<unknown> = enqueueProfileRebuild) {
  const rows = await getDb().execute(sql`
    select user_id from capability_profiles where status = 'rebuild_pending'
    union
    select psi.user_id from profile_source_inputs psi
      where psi.status = 'confirmed' and psi.revoked_at is null
        and exists (select 1 from capability_profiles cp where cp.source_input_id = psi.id and cp.status = 'invalidated')
        and not exists (select 1 from capability_profiles cp where cp.source_input_id = psi.id and cp.status <> 'invalidated')
    limit 20`);
  const users = (rows as unknown as Array<{ user_id: string }>).map((r) => r.user_id);
  for (const userId of users) await enqueue(userId);
  return users.length;
}
