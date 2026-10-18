import type PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getDb, schema } from "@ustal/database";
import { getMediaStorage } from "@ustal/storage";
import { ProfileInputExhausted, withRecoveryTracking } from "../profile-input-recovery.js";

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

  const input = await db.query.profileSourceInputs.findFirst({
    where: eq(schema.profileSourceInputs.id, job.data.sourceInputId),
  });
  if (!input) throw new Error(`profile_source_inputs ${job.data.sourceInputId} not found`);
  // Повторная доставка (повтор pg-boss или восстановление, QA 2026-10-14 №2): расшифровка уже сохранена,
  // сообщение подтверждено или отозвано — STT не повторяем и подтверждённый текст не перезаписываем.
  if (input.status !== "transcribing" || input.revokedAt) return { transcript: input.transcript, skipped: true as const };
  if (input.inputType !== "voice") {
    throw new Error(`profile_source_inputs ${input.id}: PROFILE_TRANSCRIBE вызван для text-ввода`);
  }
  if (!input.audioMediaId) {
    throw new Error(`profile_source_inputs ${input.id}: voice input без audioMediaId`);
  }
  const audioMediaId = input.audioMediaId;

  // Учтённая попытка (общий лимит неудач, QA 2026-10-14 №2): после лимита STT автоматически не вызывается.
  try {
    return await withRecoveryTracking("transcribe", { id: input.id, userId: input.userId }, () => transcribe({ id: input.id, audioMediaId }, job.id));
  } catch (error) {
    if (error instanceof ProfileInputExhausted) return { transcript: null, skipped: "recovery_exhausted" as const };
    throw error;
  }
}

async function transcribe(input: { id: string; audioMediaId: string }, traceId: string) {
  const db = getDb();
  const ai = getAiProviders();
  const media = await db.query.media.findFirst({ where: eq(schema.media.id, input.audioMediaId) });
  if (!media) throw new Error(`media ${input.audioMediaId} not found`);

  const storage = getMediaStorage();
  const filePath = await storage.resolvePath(media.storageKey);

  const sttMeta = { operationType: "profile_stt", traceId, promptVersion: "v1", schemaVersion: "v1" };
  const sttStarted = new Date();
  const sttResult = await ai.stt.transcribe({ filePath, mimeType: media.mimeType }, sttMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(sttMeta, sttStarted, { result: sttResult }));

  await db
    .update(schema.profileSourceInputs)
    .set({ transcript: sttResult.data.transcript, status: "awaiting_review" })
    .where(eq(schema.profileSourceInputs.id, input.id));

  return { transcript: sttResult.data.transcript };
}
