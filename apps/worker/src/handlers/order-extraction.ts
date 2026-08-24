import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders, moderateWithRules } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { createOntologyCandidate, findOntologyNodeForPhrase } from "@ustal/ontology";
import { getMediaStorage } from "@ustal/storage";
import { orderExtractionResultSchema } from "@ustal/validation";

export interface OrderExtractionJobData {
  orderId: string;
}

type RequirementInsert = typeof schema.orderRequirements.$inferInsert;

const REQUIREMENT_TYPES = {
  requiredCapabilities: "required_capability",
  desiredCapabilities: "desired_capability",
  requiredResources: "required_resource",
  desiredResources: "desired_resource",
} as const;

/**
 * Пайплайн заказа (docs/matching.md): текст/голос → structured extraction →
 * JSON validation → ontology mapping → risk classification → moderation →
 * embedding → (публикация — отдельным явным действием автора, см.
 * POST /orders/{id}/publish в apps/api/src/routes/orders.ts).
 *
 * Модерация (раздел 12 ТЗ + architecture.md §5 п.7): сначала детерминированные
 * правила (moderateWithRules — работает одинаково для mock и openai
 * провайдеров, не полагается на реализацию каждого), затем — если заказ
 * помечен моделью как `regulated` — жёстко manual_review (в MVP нет
 * верификации, поэтому ни один регулируемый заказ не публикуется
 * автоматически), и только для оставшихся пограничных случаев — AI-модерация.
 */
export async function handleOrderExtraction(job: PgBoss.Job<OrderExtractionJobData>) {
  const db = getDb();
  const ai = getAiProviders();
  const config = getRuntimeConfig();

  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, job.data.orderId) });
  if (!order) throw new Error(`order ${job.data.orderId} not found`);

  let sourceText = order.sourceText;

  if (!sourceText) {
    // Голосовой заказ: аудио прикреплено как order_media с media.kind='audio'
    // (см. apps/api/src/routes/orders.ts — так же переиспользуется media без
    // отдельной колонки audio_media_id на orders, по аналогии с фото).
    const attachedMedia = await db
      .select({ media: schema.media })
      .from(schema.orderMedia)
      .innerJoin(schema.media, eq(schema.orderMedia.mediaId, schema.media.id))
      .where(and(eq(schema.orderMedia.orderId, order.id), eq(schema.media.kind, "audio")));
    const audio = attachedMedia[0]?.media;
    if (!audio) throw new Error(`order ${order.id}: пустой sourceText без прикреплённого аудио`);

    const storage = getMediaStorage();
    const filePath = storage.resolvePath(audio.storageKey);
    const sttMeta = { operationType: "order_stt", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
    const sttStarted = new Date();
    const sttResult = await ai.stt.transcribe({ filePath, mimeType: audio.mimeType }, sttMeta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(sttMeta, sttStarted, { result: sttResult }));

    sourceText = sttResult.data.transcript;
    await db.update(schema.orders).set({ sourceText }).where(eq(schema.orders.id, order.id));
  }

  const extractionMeta = { operationType: "order_extraction", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
  const extractionStarted = new Date();
  const extractionResult = await ai.extraction.extractOrder({ text: sourceText }, extractionMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(extractionMeta, extractionStarted, { result: extractionResult }));

  const extracted = orderExtractionResultSchema.parse(extractionResult.data);

  const requirementRows: RequirementInsert[] = [];
  for (const [field, requirementType] of Object.entries(REQUIREMENT_TYPES) as [
    keyof typeof REQUIREMENT_TYPES,
    (typeof REQUIREMENT_TYPES)[keyof typeof REQUIREMENT_TYPES],
  ][]) {
    for (const phrase of extracted[field]) {
      const match = await findOntologyNodeForPhrase(phrase);
      if (match) {
        requirementRows.push({
          orderId: order.id,
          ontologyNodeId: match.ontologyNodeId,
          requirementType,
          isMandatory: requirementType.startsWith("required"),
        });
      } else {
        await createOntologyCandidate(phrase, []);
      }
    }
  }
  if (requirementRows.length > 0) {
    await db.insert(schema.orderRequirements).values(requirementRows);
  }

  // Risk classification (architecture.md §5 п.7): regulated > requiresQualification > обычная задача.
  const riskLevel = extracted.regulated ? 2 : extracted.requiresQualification ? 1 : 0;

  const ruleResult = moderateWithRules(sourceText);
  let moderationDecision: "allow" | "allow_with_warning" | "manual_review" | "reject";
  let moderationReason: string;

  if (ruleResult.decision) {
    moderationDecision = ruleResult.decision;
    moderationReason = ruleResult.reason ?? "";
  } else if (extracted.regulated) {
    moderationDecision = "manual_review";
    moderationReason = "regulated: в MVP нет верификации исполнителей (architecture.md §5 п.7)";
  } else {
    const modMeta = { operationType: "order_moderation", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
    const modStarted = new Date();
    const modResult = await ai.moderation.moderate({ text: sourceText, regulated: extracted.regulated, riskLevel }, modMeta);
    await db.insert(schema.aiRuns).values(buildAiRunRecord(modMeta, modStarted, { result: modResult }));
    moderationDecision = modResult.data.decision;
    moderationReason = modResult.data.reason;
  }

  await db.insert(schema.moderationCases).values({
    orderId: order.id,
    decision: moderationDecision,
    reason: moderationReason,
  });

  // "allow" и "allow_with_warning" оставляют заказ в processing — публикация
  // остаётся явным действием автора (POST /orders/{id}/publish, docs/api.md);
  // "manual_review"/"reject" переводят в moderation_hold, что технически
  // блокирует publish (canTransitionOrder требует status='processing').
  const blocksPublish = moderationDecision === "manual_review" || moderationDecision === "reject";
  let nextStatus: string = order.status;
  if (blocksPublish) {
    assertOrderTransition(order.status as never, "moderation_hold");
    nextStatus = "moderation_hold";
  }

  await db
    .update(schema.orders)
    .set({
      normalizedTitle: extracted.normalizedTitle,
      normalizedDescription: extracted.normalizedDescription,
      riskLevel,
      moderationStatus: moderationDecision,
      status: nextStatus,
    })
    .where(eq(schema.orders.id, order.id));

  await db.insert(schema.orderAiExtractions).values({
    orderId: order.id,
    extractionVersion: "v1",
    rawResult: extracted,
  });

  const embeddingMeta = { operationType: "order_embedding", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
  const embeddingStarted = new Date();
  const embeddingText = `${extracted.normalizedTitle}\n${extracted.normalizedDescription}`;
  const embeddingResult = await ai.embedding.embed([embeddingText], embeddingMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(embeddingMeta, embeddingStarted, { result: embeddingResult }));

  const [vector] = embeddingResult.data.vectors;
  if (vector) {
    await db
      .insert(schema.orderEmbeddings)
      .values({ orderId: order.id, embedding: vector, embeddingModel: config.ai.models.embedding })
      .onConflictDoUpdate({
        target: schema.orderEmbeddings.orderId,
        set: { embedding: vector, embeddingModel: config.ai.models.embedding },
      });
  }

  return { orderId: order.id, moderationDecision, status: nextStatus };
}
