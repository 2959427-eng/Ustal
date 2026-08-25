import type PgBoss from "pg-boss";
import { desc, eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import { createOntologyCandidate, findOntologyNodeForPhrase } from "@ustal/ontology";
import { getMediaStorage } from "@ustal/storage";
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
 */
export async function handleProfileExtraction(job: PgBoss.Job<ProfileExtractionJobData>) {
  const db = getDb();
  const ai = getAiProviders();
  const config = getRuntimeConfig();

  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  if (!input) throw new Error(`profile_source_inputs ${job.data.sourceInputId} not found`);

  let transcript = input.transcript;

  if (input.inputType === "voice" && !transcript) {
    if (!input.audioMediaId) {
      throw new Error(`profile_source_inputs ${input.id}: voice input без audioMediaId`);
    }
    const media = await db.query.media.findFirst({ where: eq(schema.media.id, input.audioMediaId) });
    if (!media) throw new Error(`media ${input.audioMediaId} not found`);

    const storage = getMediaStorage();
    const filePath = await storage.resolvePath(media.storageKey);

    const sttMeta = { operationType: "profile_stt", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
    const sttStarted = new Date();
    const sttResult = await ai.stt.transcribe({ filePath, mimeType: media.mimeType }, sttMeta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(sttMeta, sttStarted, { result: sttResult }));

    transcript = sttResult.data.transcript;
    await db
      .update(schema.profileSourceInputs)
      .set({ transcript })
      .where(eq(schema.profileSourceInputs.id, input.id));
  }

  const text = input.transcriptCorrected ?? transcript ?? input.rawText;
  if (!text) throw new Error(`profile_source_inputs ${input.id}: нет текста для extraction`);

  const previousProfile = await db.query.capabilityProfiles.findFirst({
    where: eq(schema.capabilityProfiles.userId, job.data.userId),
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
  const newVersion = (previousProfile?.profileVersion ?? 0) + 1;

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
