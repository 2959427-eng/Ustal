import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders } from "@ustal/ai";
import { getDb, schema } from "@ustal/database";
import { getMediaStorage } from "@ustal/storage";

export interface OrderTranscribeJobData {
  orderId: string;
}

/**
 * Пауза «Проверка транскрипции» (экраны 9/11 screens.md,
 * claude/pipeline-split-design.md) — первая половина того, что раньше было
 * единым `order-extraction.ts`: только STT, без extraction. Пишет
 * `orders.transcript` (НЕ `sourceText` — то заполняется только на шаге
 * подтверждения, POST /orders/{id}/confirm-transcript, иначе order_extraction
 * мог бы стартовать раньше, чем пользователь успел поправить текст).
 *
 * Только voice — text-заказы создаются сразу с заполненным sourceText и
 * status='confirmed', сюда не попадают (роутинг — в apps/api/src/routes/orders.ts).
 */
export async function handleOrderTranscribe(job: PgBoss.Job<OrderTranscribeJobData>) {
  const db = getDb();
  const ai = getAiProviders();

  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, job.data.orderId) });
  if (!order) throw new Error(`order ${job.data.orderId} not found`);

  const attachedMedia = await db
    .select({ media: schema.media })
    .from(schema.orderMedia)
    .innerJoin(schema.media, eq(schema.orderMedia.mediaId, schema.media.id))
    .where(and(eq(schema.orderMedia.orderId, order.id), eq(schema.media.kind, "audio")));
  const audio = attachedMedia[0]?.media;
  if (!audio) throw new Error(`order ${order.id}: нет прикреплённого аудио для транскрипции`);

  const storage = getMediaStorage();
  const filePath = await storage.resolvePath(audio.storageKey);
  const sttMeta = { operationType: "order_stt", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
  const sttStarted = new Date();
  const sttResult = await ai.stt.transcribe({ filePath, mimeType: audio.mimeType }, sttMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(sttMeta, sttStarted, { result: sttResult }));

  await db
    .update(schema.orders)
    .set({ transcript: sttResult.data.transcript, sourceStatus: "awaiting_review" })
    .where(eq(schema.orders.id, order.id));

  return { transcript: sttResult.data.transcript };
}
