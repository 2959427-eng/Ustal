import type PgBoss from "pg-boss";
import { and, desc, eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import { createOntologyCandidate, findOntologyNodeForPhrase } from "@ustal/ontology";
import { capabilityExtractionResultSchema } from "@ustal/validation";

export interface ProfileExtractionJobData {
  userId: string;
  sourceInputId: string;
}

type CapabilityInsert = Omit<typeof schema.userCapabilities.$inferInsert, "capabilityProfileId">;
type ResourceInsert = Omit<typeof schema.userResources.$inferInsert, "capabilityProfileId">;

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
export async function handleProfileExtraction(job: PgBoss.Job<ProfileExtractionJobData>) {
  const db = getDb();
  const ai = getAiProviders();
  const config = getRuntimeConfig();

  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  if (!input) throw new Error(`profile_source_inputs ${job.data.sourceInputId} not found`);

  const text = input.transcriptCorrected ?? input.transcript ?? input.rawText;
  if (!text) throw new Error(`profile_source_inputs ${input.id}: нет текста для extraction`);

  // Текущий («живой») профиль — applied, не draft: previousProfileSummary для
  // AI и база для диффа в GET /profile/draft должны быть тем, что пользователь
  // сейчас реально видит, а не незакоммиченным черновиком другого запуска.
  const previousProfile = await db.query.capabilityProfiles.findFirst({
    where: and(eq(schema.capabilityProfiles.userId, job.data.userId), eq(schema.capabilityProfiles.status, "applied")),
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
  await db.insert(schema.aiRuns).values(buildAiRunRecord(extractionMeta, extractionStarted, { result: extractionResult }));

  // Провайдер обязан вернуть данные по контракту capabilityExtractionResultSchema —
  // проверяем это явно, а не доверяем типам: ответ LLM мог не пройти
  // structured-outputs валидацию на стороне провайдера.
  const extracted = capabilityExtractionResultSchema.parse(extractionResult.data);

  // Номер версии — по максимуму СРЕДИ ВСЕХ строк пользователя (applied +
  // draft + discarded), не только applied: если пользователь отправил новую
  // правку, не решив судьбу предыдущего черновика (rate limit это разрешает,
  // до 15/час), два draft'а не должны получить одинаковый profileVersion.
  const latestAny = await db.query.capabilityProfiles.findFirst({
    where: eq(schema.capabilityProfiles.userId, job.data.userId),
    orderBy: desc(schema.capabilityProfiles.profileVersion),
  });
  const newVersion = (latestAny?.profileVersion ?? 0) + 1;

  const capabilityRows: CapabilityInsert[] = [];
  for (const capability of extracted.capabilities) {
    const match = await findOntologyNodeForPhrase(capability.label);
    if (match) {
      capabilityRows.push({
        ontologyNodeId: match.ontologyNodeId,
        label: capability.label,
        proficiency: capability.proficiency,
        evidenceType: capability.evidenceType,
        confidence: capability.confidence.toString(),
      });
    } else {
      await createOntologyCandidate(capability.label, []);
    }
  }

  const resourceRows: ResourceInsert[] = [];
  for (const resource of extracted.resources) {
    const match = await findOntologyNodeForPhrase(resource.label);
    if (match) {
      resourceRows.push({
        ontologyNodeId: match.ontologyNodeId,
        label: resource.label,
        resourceType: resource.resourceType,
        attributes: resource.attributes,
        evidenceType: resource.evidenceType,
        confidence: resource.confidence.toString(),
      });
    } else {
      await createOntologyCandidate(resource.label, []);
    }
  }

  const [newProfile] = await db
    .insert(schema.capabilityProfiles)
    .values({
      userId: job.data.userId,
      summary: extracted.summary,
      profileVersion: newVersion,
      extractionVersion: "v1",
      embeddingModel: config.ai.models.embedding,
      status: "draft",
    })
    .returning();
  if (!newProfile) throw new Error("Failed to create capability_profiles row");

  if (capabilityRows.length > 0) {
    await db
      .insert(schema.userCapabilities)
      .values(capabilityRows.map((row) => ({ ...row, capabilityProfileId: newProfile.id })));
  }
  if (resourceRows.length > 0) {
    await db
      .insert(schema.userResources)
      .values(resourceRows.map((row) => ({ ...row, capabilityProfileId: newProfile.id })));
  }

  const embeddingMeta = {
    operationType: "profile_embedding",
    traceId: job.id,
    promptVersion: "v1",
    schemaVersion: "v1",
  };
  const embeddingStarted = new Date();
  const embeddingResult = await ai.embedding.embed([extracted.summary], embeddingMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(embeddingMeta, embeddingStarted, { result: embeddingResult }));

  const [vector] = embeddingResult.data.vectors;
  if (vector) {
    await db.insert(schema.profileEmbeddings).values({
      capabilityProfileId: newProfile.id,
      embedding: vector,
      embeddingModel: config.ai.models.embedding,
    });
  }

  return { profileId: newProfile.id, profileVersion: newVersion };
}
