import { priorFactsFromRows, prepareDocument, persistDocument, recordUnknownConcepts } from "../semantic.js";
import { planNegativeOverrides, scopeRefusalsOfPriorSkills, unmappedResourcesToCarry } from "../profile-negatives.js";
import { carryForwardProfileItems, explicitLabelKeys } from "../profile-merge.js";
import { rebuildProfileIfNeeded } from "../profile-rebuild.js";
import { earlierPendingInputs, enqueueNextPendingInput, ProfileInputExhausted, withRecoveryTracking } from "../profile-input-recovery.js";
import { deduplicatePersistedProfileResources } from "../profile-resource-identity.js";
import type PgBoss from "pg-boss";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, PROFILE_SOURCE_SEPARATOR, schema } from "@ustal/database";
import { capabilityExtractionResultSchema } from "@ustal/validation";

export interface ProfileExtractionJobData {
  userId: string;
  sourceInputId: string;
}

class ProfileBaseChanged extends Error {}

type CapabilityInsert = Omit<
  typeof schema.userCapabilities.$inferInsert,
  "capabilityProfileId"
>;
type ResourceInsert = Omit<
  typeof schema.userResources.$inferInsert,
  "capabilityProfileId"
>;

/**
 * Пайплайн профиля (docs/matching.md): текст/транскрипция → structured
 * extraction → JSON validation → ontology mapping → business validation →
 * новая версия профиля → embedding → резюме.
 *
 * Ontology mapping (раздел 11 ТЗ): LLM не создаёт активные узлы онтологии —
 * способность/ресурс без совпадения в ontology_nodes не попадает в
 * user_capabilities/user_resources (структурные поля для canonical-match в
 * Фазе 4), но не теряется полностью: остаётся в свободном тексте
 * capability_profiles.summary и в его embedding, то есть всё ещё участвует в
 * semantic similarity (matching.md §13.2); несовпавшая фраза уходит в
 * ontology_candidates на ручное подтверждение админом (Фаза 8).
 *
 * capability_profiles append-only (docs/data-model.md): каждый вызов создаёт
 * новую версию, старая не перезаписывается.
 *
 * Пауза «Проверка транскрипции» (claude/pipeline-split-design.md): STT для
 * voice-ввода больше не делается здесь — этот job теперь ставится в очередь
 * только после явного подтверждения (POST /profile/inputs/{id}/confirm,
 * status='confirmed'), STT — отдельный job (profile-transcribe.ts).
 *
 * Пауза «Подтверждение изменений» (экран 10, claude/pipeline-split-design.md):
 * новая версия создаётся со status='draft', а не сразу «текущей» —
 * пользователь явно применяет её (POST /profile/draft/{id}/apply) или
 * отклоняет (POST /profile/draft/{id}/discard). `GET /profile` отдаёт только
 * status='applied'.
 */
export async function handleProfileExtraction(
  job: PgBoss.Job<ProfileExtractionJobData>,
) {
  const { userId, sourceInputId } = job.data;
  const input = await getDb().query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, sourceInputId),
  });
  // Чужое, неподтверждённое или отозванное сообщение — прежние проверки и ошибки extractProfile.
  if (!input || input.userId !== userId || input.status !== "confirmed" || input.revokedAt)
    return extractWithRebase(job);
  // Повторная доставка уже обработанного сообщения: возвращаем его версию, ничего не пересчитывая.
  const done = await getDb().query.capabilityProfiles.findFirst({
    where: and(
      eq(schema.capabilityProfiles.sourceInputId, sourceInputId),
      ne(schema.capabilityProfiles.status, "invalidated"),
    ),
  });
  if (done) return { profileId: done.id, profileVersion: done.profileVersion };

  // Порядок сообщений одного пользователя (QA 2026-10-14, дефект №2): профиль накопительный, и порядок
  // сообщений в нём значим («Могу копать» → «Больше не копаю»). Задача могла прийти раньше задачи более
  // раннего сообщения (повтор после сбоя, восстановление, несколько worker) — тогда сначала разбираем
  // более ранние необработанные сообщения этого пользователя. Сообщение, уже разобранное параллельной
  // задачей, разбор не повторяет; исчерпавшее раунды восстановления — не задерживает остальные.
  for (const earlier of await earlierPendingInputs(userId, sourceInputId)) {
    try {
      await withRecoveryTracking("extraction", { id: earlier.id, userId },
        () => extractWithRebase({ ...job, data: { userId, sourceInputId: earlier.id } }));
    } catch (error) {
      const stillPending = (await earlierPendingInputs(userId, sourceInputId)).some((p) => p.id === earlier.id);
      if (stillPending) throw new EarlierInputFailed(earlier.id, error);
    }
  }
  // Учтённая попытка: общий лимит неудач хранится в profile_input_recovery (см. profile-input-recovery.ts).
  const result = await withRecoveryTracking("extraction", { id: sourceInputId, userId }, () => extractWithRebase(job));
  // Следующее по порядку сообщение, ждущее разбора, ставим сразу — не дожидаясь тика восстановления.
  await enqueueNextPendingInput(userId, sourceInputId).catch((error) =>
    console.error(JSON.stringify({ event: "profile_next_input_enqueue_failed", sourceInputId,
      error: error instanceof Error ? error.name : "unknown" })));
  return result;
}

/**
 * Точка входа задачи pg-boss. Сообщение с исчерпанным лимитом неудач пропускается. Если не удалось разобрать
 * более раннее сообщение, это сообщение откладывается
 * (задача завершается без ошибки и без разбора): у раннего сообщения свои повторы, а это поставит
 * восстановление после него. Так неудачи чужого сообщения не расходуют раунды восстановления этого.
 */
export async function runProfileExtractionJob(job: PgBoss.Job<ProfileExtractionJobData>) {
  try {
    return await handleProfileExtraction(job);
  } catch (error) {
    if (error instanceof ProfileInputExhausted) {
      // Лимит неудач исчерпан: задача завершается без ошибки — pg-boss не повторяет, AI не вызывается.
      return { skipped: "recovery_exhausted" as const };
    }
    if (!(error instanceof EarlierInputFailed)) throw error;
    console.log(JSON.stringify({ event: "profile_extraction_deferred", sourceInputId: job.data.sourceInputId,
      waitingFor: error.earlierInputId }));
    return { deferred: true as const, waitingFor: error.earlierInputId };
  }
}

export class EarlierInputFailed extends Error {
  constructor(readonly earlierInputId: string, cause: unknown) {
    super(`Earlier profile input ${earlierInputId} is not processed yet`, { cause });
  }
}

async function extractWithRebase(job: PgBoss.Job<ProfileExtractionJobData>) {
  // Concurrent extractions may finish in either order. Recompute against the
  // committed winner instead of saving two snapshots of the same old profile.
  for (let attempt = 0; ; attempt++) {
    try { return await extractProfile(job); }
    catch (error) {
      if (!(error instanceof ProfileBaseChanged) || attempt >= 4) throw error;
    }
  }
}

async function extractProfile(job: PgBoss.Job<ProfileExtractionJobData>) {
  const db = getDb();
  const ai = getAiProviders();
  const config = getRuntimeConfig();

  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  if (!input)
    throw new Error(
      `profile_source_inputs ${job.data.sourceInputId} not found`,
    );

  if (input.userId !== job.data.userId || input.status !== "confirmed")
    throw new Error("Profile source is not confirmed by this user");
  // Source revoke (2026-09-28): a withdrawn message never enters the AI profile.
  if (input.revokedAt) throw new Error("Profile source was revoked by its owner");
  // A draft invalidated by a revoke/rebuild does not count: the message is re-extracted on top of the
  // rebuilt profile.
  const priorRun = await db.query.capabilityProfiles.findFirst({
    where: and(
      eq(schema.capabilityProfiles.sourceInputId, input.id),
      ne(schema.capabilityProfiles.status, "invalidated"),
    ),
  });
  if (priorRun)
    return { profileId: priorRun.id, profileVersion: priorRun.profileVersion };

  const text = input.transcriptCorrected ?? input.transcript ?? input.rawText;
  if (!text)
    throw new Error(
      `profile_source_inputs ${input.id}: нет текста для extraction`,
    );

  // The base must never contain a revoked message: finish a pending rebuild first (no-op otherwise).
  await rebuildProfileIfNeeded(job.data.userId, job.id);

  // Pending messages form one cumulative proposal. The API still compares it
  // with the applied profile, but extraction must retain earlier pending inputs.
  const previousProfile = await db.query.capabilityProfiles.findFirst({
    where: and(
      eq(schema.capabilityProfiles.userId, job.data.userId),
      inArray(schema.capabilityProfiles.status, ["applied", "draft"]),
    ),
    orderBy: desc(schema.capabilityProfiles.profileVersion),
  });

  const extractionMeta = {
    operationType: "profile_extraction",
    traceId: job.id,
    promptVersion: "v1",
    schemaVersion: "v1",
  };
  const extractionStarted = new Date();
  const extractionResult = await ai.extraction.extractCapabilityProfile(
    { text, previousProfileSummary: previousProfile?.summary },
    extractionMeta,
  );
  await db
    .insert(schema.aiRuns)
    .values(
      buildAiRunRecord(extractionMeta, extractionStarted, {
        result: extractionResult,
      }),
    );

  // Провайдер обязан вернуть данные по контракту capabilityExtractionResultSchema —
  // проверяем это явно, а не доверяем типам: ответ LLM мог не пройти
  // structured-outputs валидацию на стороне провайдера.
  const extracted = capabilityExtractionResultSchema.parse(
    extractionResult.data,
  );

  const previousDoc = previousProfile
    ? await db.query.matchingDocuments.findFirst({
        where: eq(schema.matchingDocuments.profileId, previousProfile.id),
        orderBy: (t, { desc }) => desc(t.processedAt),
      })
    : undefined;
  const priorFacts = previousDoc
    ? await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, previousDoc.id))
    : [];
  // Обновление по одному сообщению (2026-10-13): состояние применённого профиля + только новое сообщение;
  // прежние сообщения заново не разбираются (см. PriorProfileState). Первое сообщение — как раньше.
  const incremental = !!previousDoc;
  const prepared = previousDoc
    ? await prepareDocument("profile", text, extracted, job.id, { sourceText: previousDoc.sourceText, facts: priorFactsFromRows(priorFacts) })
    : await prepareDocument("profile", [previousProfile?.summary, text].filter(Boolean).join(PROFILE_SOURCE_SEPARATOR), extracted, job.id);
  // Диагностика (QA 2026-10-14, №4/№5): сколько операций модели сервер отклонил и почему (без текста профиля).
  if (prepared.rejectedOperations?.length)
    console.log(JSON.stringify({ event: "profile_update_guard_rejected", sourceInputId: input.id,
      reasons: prepared.rejectedOperations.map((r) => r.reason) }));
  // Профиль без документа (старые данные, только summary): прежние правила переноса пунктов.
  const prior = priorFacts.map((f) => ({ ...f, nodeIds: (f.nodeIds ?? []) as string[] }));
  const overrides = incremental
    ? { excludedNodeIds: new Set<string>(), supersededLabels: new Set<string>(), relabel: new Map<string, string>() }
    : planNegativeOverrides(prepared.facts, prior);
  if (!incremental) scopeRefusalsOfPriorSkills(prepared.facts, prior);
  let created = false;
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${job.data.userId}, 0))`,
    );
    const [source] = await tx
      .select({ revokedAt: schema.profileSourceInputs.revokedAt })
      .from(schema.profileSourceInputs)
      .where(eq(schema.profileSourceInputs.id, input.id));
    if (source?.revokedAt)
      throw new Error("Profile source was revoked by its owner");
    const duplicate = await tx.query.capabilityProfiles.findFirst({
      where: and(
        eq(schema.capabilityProfiles.sourceInputId, input.id),
        ne(schema.capabilityProfiles.status, "invalidated"),
      ),
    });
    if (duplicate)
      return {
        profileId: duplicate.id,
        profileVersion: duplicate.profileVersion,
      };
    const latest = await tx.query.capabilityProfiles.findFirst({
      where: eq(schema.capabilityProfiles.userId, job.data.userId),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    const baseNow = await tx.query.capabilityProfiles.findFirst({
      where: and(
        eq(schema.capabilityProfiles.userId, job.data.userId),
        inArray(schema.capabilityProfiles.status, ["applied", "draft"]),
      ),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    const rebuildPending = await tx.query.capabilityProfiles.findFirst({
      where: and(eq(schema.capabilityProfiles.userId, job.data.userId),
        eq(schema.capabilityProfiles.status, "rebuild_pending")),
    });
    if (baseNow?.id !== previousProfile?.id || rebuildPending)
      throw new ProfileBaseChanged(
        "Profile changed during extraction; retry against current cumulative version",
      );
    const [profile] = await tx
      .insert(schema.capabilityProfiles)
      .values({
        userId: job.data.userId,
        summary: extracted.summary,
        profileVersion: (latest?.profileVersion ?? 0) + 1,
        extractionVersion: prepared.processingVersion,
        embeddingModel: prepared.embeddingModel,
        sourceInputId: input.id,
        status: "draft",
      })
      .returning();
    if (!profile) throw new Error("Failed to create profile");
    const saved = await persistDocument(tx, { profileId: profile.id }, prepared);
    // Накопительный профиль: существующие узлы сохраняют прежний label, отсутствующие в новом
    // ответе AI старые пункты переносятся; удаляются только явно исключённые (kind "exclude").
    await carryForwardProfileItems(tx, {
      draftProfileId: profile.id,
      draftDocumentId: saved.id,
      previousProfileId: previousProfile?.id,
      excludedNodeIds: overrides.excludedNodeIds,
      supersededLabels: overrides.supersededLabels,
      relabel: overrides.relabel,
      // При обновлении по одному сообщению новый документ — уже полное состояние профиля: прежние пункты не
      // переносятся отдельно (иначе вернулись бы убранные), сохраняются только их подписи.
      carryNothing: incremental,
      explicitLabels: explicitLabelKeys(prepared.facts),
    });
    // Ресурсы без ontology-узла, которые модель не повторила и пользователь не убрал (см. unmappedResourcesToCarry).
    if (!saved.reused && !incremental)
      for (const f of unmappedResourcesToCarry(prepared.facts, prior)) {
        const { id: _id, documentId: _d, ...rest } = f;
        void _id; void _d;
        await tx.insert(schema.matchingFacts).values({ ...rest, documentId: saved.id });
      }
    await deduplicatePersistedProfileResources(tx, profile.id, saved.id, prepared.sourceText);
    await tx
      .insert(schema.profileEmbeddings)
      .values({
        capabilityProfileId: profile.id,
        embedding: prepared.embedding,
        embeddingModel: prepared.embeddingModel,
      });
    created = true;
    return { profileId: profile.id, profileVersion: profile.profileVersion };
  });
  // Only after commit: a revoked/duplicate run must not leak its phrases into the moderation queue.
  if (created) await recordUnknownConcepts(prepared.addedFacts ?? prepared.facts, job.id);
  return result;
}
