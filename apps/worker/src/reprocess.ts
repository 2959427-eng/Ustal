import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, loadProfileLineage, schema } from "@ustal/database";
import { rebuildProfileIfNeeded } from "./profile-rebuild.js";
import { getAiProviders } from "@ustal/ai";
import {
  prepareDocument,
  persistDocument,
  requestRematch,
} from "./semantic.js";
import { handleMatchingRun } from "./handlers/matching-run.js";

export async function reprocessProfile(
  profileId: string,
  sourceInputId?: string,
  apply = false,
) {
  const db = getDb();
  const profile = await db.query.capabilityProfiles.findFirst({
    where: eq(schema.capabilityProfiles.id, profileId),
  });
  // Source revoke (2026-09-28): never reprocess text that still contains a revoked message; the profile is
  // rebuilt from the remaining messages instead (normal pipeline, new applied version, rematch).
  if (profile?.status === "rebuild_pending" ||
    (profile?.status === "applied" && (await loadProfileLineage(db, profile)).inputs.some((i) => i.revokedAt))) {
    if (!apply) return { profileId, action: "rebuild-after-source-revoke", dryRun: true };
    return rebuildProfileIfNeeded(profile.userId);
  }
  if (!profile || profile.status !== "applied")
    throw new Error("Backfill requires an applied profile");
  const priorDoc = await db.query.matchingDocuments.findFirst({
    where: eq(schema.matchingDocuments.profileId, profile.id),
    orderBy: (t, { desc }) => desc(t.processedAt),
  });
  const sourceId = profile.sourceInputId ?? sourceInputId;
  const source = sourceId
    ? await db.query.profileSourceInputs.findFirst({
        where: eq(schema.profileSourceInputs.id, sourceId),
      })
    : undefined;
  if (
    !priorDoc &&
    (!source ||
      source.userId !== profile.userId ||
      source.status !== "confirmed" ||
      source.createdAt > profile.createdAt)
  )
    throw new Error(
      "Legacy source provenance unresolved: supply a verified confirmed --source-input-id predating this profile",
    );
  // Already applied summary is authoritative for old cumulative profiles; never auto-apply later drafts.
  const text =
    priorDoc?.sourceText ??
    [
      profile.summary,
      source?.transcriptCorrected ?? source?.transcript ?? source?.rawText,
    ]
      .filter(Boolean)
      .join("\nПодтвержденный ввод:\n");
  if (!apply)
    return {
      profileId,
      sourceInputId: sourceId ?? null,
      action: "rebuild-derived-facts",
      dryRun: true,
    };
  const doc = await prepareDocument(
    "profile",
    text,
    { summary: profile.summary },
    randomUUID(),
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${profile.userId},0))`,
    );
    const [current] = await tx
      .select()
      .from(schema.capabilityProfiles)
      .where(eq(schema.capabilityProfiles.id, profileId))
      .for("update");
    if (current?.status !== "applied")
      throw new Error("Applied profile changed during reprocessing");
    const result = await persistDocument(tx, { profileId }, doc);
    if (!result.reused) {
      await tx
        .insert(schema.profileEmbeddings)
        .values({
          capabilityProfileId: profileId,
          embedding: doc.embedding,
          embeddingModel: doc.embeddingModel,
        })
        .onConflictDoUpdate({
          target: schema.profileEmbeddings.capabilityProfileId,
          set: { embedding: doc.embedding, embeddingModel: doc.embeddingModel },
        });
      await requestRematch(tx, profile.userId);
    }
    return result;
  });
}

export async function reprocessOrder(orderId: string, apply = false) {
  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(schema.orders.id, orderId),
  });
  if (!order || order.status !== "published" || !order.sourceText)
    throw new Error(
      "Backfill requires an open order with confirmed source text",
    );
  if (!apply)
    return {
      orderId,
      action: "rebuild-derived-facts-and-rematch",
      dryRun: true,
    };
  const extracted = await db.query.orderAiExtractions.findFirst({
    where: eq(schema.orderAiExtractions.orderId, orderId),
    orderBy: (t, { desc }) => desc(t.createdAt),
  });
  const doc = await prepareDocument(
    "order",
    order.sourceText,
    extracted?.rawResult ?? {},
    randomUUID(),
  );
  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orderId},1))`,
    );
    const [current] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .for("update");
    if (
      current?.status !== "published" ||
      current.sourceText !== order.sourceText
    )
      throw new Error("Order changed during reprocessing");
    const result = await persistDocument(tx, { orderId }, doc);
    if (!result.reused) await tx
      .insert(schema.orderEmbeddings)
      .values({
        orderId,
        embedding: doc.embedding,
        embeddingModel: doc.embeddingModel,
      })
      .onConflictDoUpdate({
        target: schema.orderEmbeddings.orderId,
        set: { embedding: doc.embedding, embeddingModel: doc.embeddingModel },
      });
    return result;
  });
  // Retrying also reruns matching if a prior process stopped after saving the document.
  const matching = await handleMatchingRun({
    id: randomUUID(),
    data: { orderId },
  } as never);
  return { ...saved, matching };
}
