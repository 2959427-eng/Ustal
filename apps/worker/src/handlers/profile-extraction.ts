import { prepareDocument, persistDocument } from "../semantic.js";
import { planNegativeOverrides } from "../profile-negatives.js";
import { carryForwardProfileItems } from "../profile-merge.js";
import type PgBoss from "pg-boss";
import { and, desc, eq, sql } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import {
  createOntologyCandidate,
  findOntologyNodeForPhrase,
} from "@ustal/ontology";
import { capabilityExtractionResultSchema } from "@ustal/validation";

export interface ProfileExtractionJobData {
  userId: string;
  sourceInputId: string;
}

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
  const priorRun = await db.query.capabilityProfiles.findFirst({
    where: eq(schema.capabilityProfiles.sourceInputId, input.id),
  });
  if (priorRun)
    return { profileId: priorRun.id, profileVersion: priorRun.profileVersion };

  const text = input.transcriptCorrected ?? input.transcript ?? input.rawText;
  if (!text)
    throw new Error(
      `profile_source_inputs ${input.id}: нет текста для extraction`,
    );

  // Текущий («живой») профиль — applied, не draft: previousProfileSummary для
  // AI и база для диффа в GET /profile/draft должны быть тем, что пользователь
  // сейчас реально видит, а не незакоммиченным черновиком другого запуска.
  const previousProfile = await db.query.capabilityProfiles.findFirst({
    where: and(
      eq(schema.capabilityProfiles.userId, job.data.userId),
      eq(schema.capabilityProfiles.status, "applied"),
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
  const source = [previousDoc?.sourceText ?? previousProfile?.summary, text]
    .filter(Boolean)
    .join("\nПоследнее изменение пользователя:\n");
  const prepared = await prepareDocument("profile", source, extracted, job.id);
  // Факты прежнего профиля: новые отрицательные факты («продал машину», «больше не работаю
  // таксистом») отменяют их и по ontology-узлу, и по смыслу — такой пункт не переносится.
  const priorFacts = previousDoc
    ? await db.select().from(schema.matchingFacts).where(eq(schema.matchingFacts.documentId, previousDoc.id))
    : [];
  const overrides = planNegativeOverrides(
    prepared.facts,
    priorFacts.map((f) => ({ ...f, nodeIds: (f.nodeIds ?? []) as string[] })),
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${job.data.userId}, 0))`,
    );
    const duplicate = await tx.query.capabilityProfiles.findFirst({
      where: eq(schema.capabilityProfiles.sourceInputId, input.id),
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
    const appliedNow = await tx.query.capabilityProfiles.findFirst({
      where: and(
        eq(schema.capabilityProfiles.userId, job.data.userId),
        eq(schema.capabilityProfiles.status, "applied"),
      ),
      orderBy: desc(schema.capabilityProfiles.profileVersion),
    });
    if (appliedNow?.id !== previousProfile?.id)
      throw new Error(
        "Profile changed during extraction; retry against current applied version",
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
    });
    await tx
      .insert(schema.profileEmbeddings)
      .values({
        capabilityProfileId: profile.id,
        embedding: prepared.embedding,
        embeddingModel: prepared.embeddingModel,
      });
    return { profileId: profile.id, profileVersion: profile.profileVersion };
  });
}
