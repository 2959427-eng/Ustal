import type PgBoss from "pg-boss";
import { getAiProviders } from "@ustal/ai";
import { getDb, schema } from "@ustal/database";

export interface ProfileExtractionJobData {
  userId: string;
  sourceInputId: string;
}

/**
 * Пайплайн профиля (docs/matching.md): текст/транскрипция → structured
 * extraction → JSON validation → ontology mapping → business validation →
 * новая версия профиля → embedding → резюме. Ontology mapping и embedding
 * подключаются вместе с packages/ontology и packages/matching в Фазе 2.
 */
export async function handleProfileExtraction(job: PgBoss.Job<ProfileExtractionJobData>) {
  const db = getDb();
  const ai = getAiProviders();

  const input = await db.query.profileSourceInputs.findFirst({
    where: (t, { eq }) => eq(t.id, job.data.sourceInputId),
  });
  if (!input) throw new Error(`profile_source_inputs ${job.data.sourceInputId} not found`);

  const text = input.transcriptCorrected ?? input.transcript ?? input.rawText;
  if (!text) throw new Error("No text to extract from");

  const result = await ai.extraction.extractCapabilityProfile(
    { text },
    {
      operationType: "profile_extraction",
      traceId: job.id,
      promptVersion: "v1",
      schemaVersion: "v1",
    },
  );

  // TODO Фаза 2: ontology mapping способностей/ресурсов на ontology_nodes,
  // запись новой версии capability_profiles + user_capabilities/user_resources,
  // embedding резюме через ai.embedding.embed(...).
  void result;
}
