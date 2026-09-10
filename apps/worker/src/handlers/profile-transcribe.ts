import type PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getDb, schema } from "@ustal/database";
import { getMediaStorage } from "@ustal/storage";

export interface ProfileTranscribeJobData {
  sourceInputId: string;
}

/**
 * Пауза «Проверка транскрипции» (экран 9 screens.md,
 * claude/pipeline-split-design.md) — первая половина того, что раньше было
 * единым `profile-extraction.ts`: только STT, без extraction. Ставится в
 * очередь вместо `PROFILE_EXTRACTION` для voice-ввода (POST /profile/inputs);
 * `PROFILE_EXTRACTION` теперь ставится отдельно, только по явному
 * POST /profile/inputs/{id}/confirm.
 *
 * Только voice — text никогда сюда не попадает (роутинг решается в
 * apps/api/src/routes/profile.ts на этапе создания строки).
 */
export async function handleProfileTranscribe(job: PgBoss.Job<ProfileTranscribeJobData>) {
  const db = getDb();
  const ai = getAiProviders();

  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  if (!input) throw new Error(`profile_source_inputs ${job.data.sourceInputId} not found`);
  if (input.inputType !== "voice") {
    throw new Error(`profile_source_inputs ${input.id}: PROFILE_TRANSCRIBE вызван для text-ввода`);
  }
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

  await db
    .update(schema.profileSourceInputs)
    .set({ transcript: sttResult.data.transcript, status: "awaiting_review" })
    .where(eq(schema.profileSourceInputs.id, input.id));

  return { transcript: sttResult.data.transcript };
}
