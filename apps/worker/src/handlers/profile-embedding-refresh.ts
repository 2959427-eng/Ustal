import { assertConsentResultCommit, consentSourceBlocked } from "../worker-consent.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { getDb, schema } from "@ustal/database";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { isLift, SUPERSEDED_KIND } from "@ustal/matching";

/**
 * Пересчёт векторов ТЕКУЩЕГО профиля пользователя после прямых действий кнопкой (2026-10-17; аудит Codex №1/№2).
 *
 * Состояние — флаг версии capability_profiles.embedding_stale: API ставит его в транзакции действия (и переносит на
 * следующую версию, пока не сброшен). Пока флаг стоит, matching не использует вектор документа/профиля как
 * положительный сигнал (matching-run: retrieval и documentSimilarity) — без ложных совпадений по убранному навыку.
 * Задача не привязана к версии: всегда считает текущую applied-версию — вектор документа (из действующих навыков) и
 * векторы фактов без вектора (части составных фактов). Один вызов embedding, без extraction/нормализации. Запись и
 * сброс флага — атомарно под lock (userId, 0) и только если текущая версия И её последний документ всё ещё те, для
 * которых посчитано (reprocess может записать новый документ в той же версии): флаг более новой версии старая задача
 * сбросить не может. Иначе — считается заново.
 */
const MAX_ROUNDS = 3;
const currentApplied = (db: Pick<ReturnType<typeof getDb>, "query">, userId: string) => db.query.capabilityProfiles.findFirst({
  where: and(eq(schema.capabilityProfiles.userId, userId), eq(schema.capabilityProfiles.status, "applied")),
  orderBy: desc(schema.capabilityProfiles.profileVersion),
});

export async function handleProfileEmbeddingRefresh(job: PgBoss.Job<{ userId: string }>) {
  const db = getDb();
  const { userId } = job.data;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const profile = await currentApplied(db, userId);
    // Нет применённой версии (идёт пересборка): новая версия считает свои векторы сама.
    if (!profile) return { skipped: "no_applied_profile" as const };
    const doc = await db.query.matchingDocuments.findFirst({
      where: eq(schema.matchingDocuments.profileId, profile.id), orderBy: desc(schema.matchingDocuments.processedAt),
    });
    if (!doc) return { skipped: "no_document" as const };
    const facts = await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, doc.id));
    const missing = facts.filter((f) => f.kind !== SUPERSEDED_KIND && !(f.embedding as number[] | null)?.length);
    if (!profile.embeddingStale && !missing.length) return { skipped: "clean" as const };
    const positive = facts.filter((f) => f.kind === "capability" && !isLift(f as never)).map((f) => f.phrase).join("\n");
    const meta = { operationType: "matching_fact_embeddings", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
    const started = new Date();
    const result = await getAiProviders().embedding.embed([positive || "нет подтвержденных способностей", ...missing.map((f) => f.phrase)], meta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(meta, started, { result }));
    const vectors = result.data.vectors;
    if (vectors.length !== missing.length + 1 || vectors.some((v) => v.length !== 1536 || !v.some((x) => x !== 0)))
      throw new Error("Invalid semantic embeddings");
    const written = await db.transaction(async (tx) => {
    await assertConsentResultCommit(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const now = await currentApplied(tx, userId);
      if (now?.id !== profile.id) return false; // новая версия за время вызова — считать заново
      // Переобработка (reprocess) пишет новый документ В ТОЙ ЖЕ версии: считаем по последнему документу версии.
      const latestDoc = await tx.query.matchingDocuments.findFirst({
        where: eq(schema.matchingDocuments.profileId, profile.id), orderBy: desc(schema.matchingDocuments.processedAt),
      });
      if (latestDoc?.id !== doc.id) return false;
      await tx.update(schema.matchingDocuments).set({ embedding: vectors[0]! }).where(eq(schema.matchingDocuments.id, doc.id));
      await tx.update(schema.profileEmbeddings).set({ embedding: vectors[0]! }).where(eq(schema.profileEmbeddings.capabilityProfileId, profile.id));
      for (const [i, f] of missing.entries())
        await tx.update(schema.matchingFacts).set({ embedding: vectors[i + 1]! }).where(eq(schema.matchingFacts.id, f.id));
      await tx.update(schema.capabilityProfiles).set({ embeddingStale: false }).where(eq(schema.capabilityProfiles.id, profile.id));
      await tx.insert(schema.rematchRequests).values({ userId })
        .onConflictDoUpdate({ target: schema.rematchRequests.userId, set: { requestedAt: sql`now()`, cursor: null } });
      return true;
    });
    if (written) return { refreshed: true as const };
  }
  // Профиль всё время менялся: флаг остаётся (fail-safe) — повтор pg-boss или диспетчер.
  throw new Error("Profile kept changing during embedding refresh; retry");
}

/** Постановка задачи: одна на пользователя (singletonKey); при сбое строка запроса остаётся для диспетчера. */
export async function enqueueEmbeddingRefresh(userId: string) {
  const boss = await getBoss();
  await boss.send(JOB_TYPES.PROFILE_EMBEDDING_REFRESH, { userId },
    { retryLimit: 4, retryDelay: 5, retryBackoff: true, singletonKey: `profile-embedding:${userId}` });
}

/** Страховка (тик worker): текущие версии с устаревшим вектором, задача которых потерялась или не была поставлена. */
export async function dispatchEmbeddingRefreshes(enqueue: (userId: string) => Promise<unknown> = enqueueEmbeddingRefresh) {
  const rows = await getDb().select({ userId: schema.capabilityProfiles.userId }).from(schema.capabilityProfiles)
    .where(and(eq(schema.capabilityProfiles.embeddingStale, true), eq(schema.capabilityProfiles.status, "applied"))).limit(20);
  for (const r of rows) if (!await consentSourceBlocked("embedding_refresh", r.userId)) await enqueue(r.userId);
  return rows.length;
}
