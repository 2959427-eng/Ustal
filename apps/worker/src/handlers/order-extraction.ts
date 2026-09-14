import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";
import { buildAiRunRecord, getAiProviders, moderateWithRules } from "@ustal/ai";
import { getRuntimeConfig } from "@ustal/config";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { createOntologyCandidate, findOntologyNodeForPhrase } from "@ustal/ontology";
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
 *
 * Пауза «Проверка транскрипции» (claude/pipeline-split-design.md): STT для
 * voice-заказа больше не делается здесь — этот job ставится в очередь
 * только после подтверждения транскрипта (POST /orders/{id}/confirm-transcript),
 * `sourceText` к этому моменту уже заполнен. STT — отдельный job
 * (order-transcribe.ts).
 */
async function extract(job: PgBoss.Job<OrderExtractionJobData>, stage: (name: string) => void) {
  const db = getDb();
  const ai = getAiProviders();
  const config = getRuntimeConfig();

  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, job.data.orderId) });
  if (!order) throw new Error(`order ${job.data.orderId} not found`);

  // Пауза «Проверка транскрипции» (claude/pipeline-split-design.md): STT для
  // voice-заказа больше не делается здесь — этот job теперь ставится в
  // очередь только после явного подтверждения (POST /orders/{id}/confirm-
  // transcript, sourceStatus='confirmed', sourceText уже заполнен). STT —
  // отдельный job (order-transcribe.ts).
  const sourceText = order.sourceText;
  if (!sourceText) {
    throw new Error(`order ${order.id}: пустой sourceText (sourceStatus=${order.sourceStatus}) — extraction должен запускаться только после подтверждения транскрипта`);
  }

  const extractionMeta = { operationType: "order_extraction", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
  const extractionStarted = new Date();
  stage("openai:start");
  const extractionResult = await ai.extraction.extractOrder({ text: sourceText }, extractionMeta);
  stage("openai:done");
  await db.insert(schema.aiRuns).values(buildAiRunRecord(extractionMeta, extractionStarted, { result: extractionResult }));

  const extracted = orderExtractionResultSchema.parse(extractionResult.data);

  stage("validation:done");
  stage("ontology:start");
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
  stage("ontology:done");

  // Risk classification (architecture.md §5 п.7): regulated > requiresQualification > обычная задача.
  const riskLevel = extracted.regulated ? 2 : extracted.requiresQualification ? 1 : 0;

  stage("moderation:start");
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

  stage("moderation:done");

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

  const embeddingMeta = { operationType: "order_embedding", traceId: job.id, promptVersion: "v1", schemaVersion: "v1" };
  const embeddingStarted = new Date();
  const embeddingText = `${extracted.normalizedTitle}\n${extracted.normalizedDescription}`;
  stage("embedding:start");
  const embeddingResult = await ai.embedding.embed([embeddingText], embeddingMeta);
  await db.insert(schema.aiRuns).values(buildAiRunRecord(embeddingMeta, embeddingStarted, { result: embeddingResult }));

  stage("embedding:done");
  stage("db-update:start");
  await db.transaction(async (tx) => {
    // Lock the order before committing results; cancellation must win over a late worker.
    const [current] = await tx.select().from(schema.orders).where(eq(schema.orders.id, order.id)).for("update");
    if (!current || current.status !== "processing") return;
    await tx.delete(schema.orderRequirements).where(eq(schema.orderRequirements.orderId, order.id));
    if (requirementRows.length) await tx.insert(schema.orderRequirements).values(requirementRows);
    await tx.insert(schema.moderationCases).values({
      orderId: order.id,
      decision: moderationDecision,
      reason: moderationReason,
    });

    await tx
      .update(schema.orders)
      .set({
        normalizedTitle: extracted.normalizedTitle,
        normalizedDescription: extracted.normalizedDescription,
        riskLevel,
        moderationStatus: moderationDecision,
        status: nextStatus,
      })
      .where(eq(schema.orders.id, order.id));

    await tx.insert(schema.orderAiExtractions).values({
      orderId: order.id,
      extractionVersion: "v1",
      rawResult: extracted,
    });

    const [vector] = embeddingResult.data.vectors;
    if (vector) {
      await tx
        .insert(schema.orderEmbeddings)
        .values({ orderId: order.id, embedding: vector, embeddingModel: config.ai.models.embedding })
        .onConflictDoUpdate({
          target: schema.orderEmbeddings.orderId,
          set: { embedding: vector, embeddingModel: config.ai.models.embedding },
        });
    }

  });
  stage("db-update:done");

  return { orderId: order.id, moderationDecision, status: nextStatus };
}

/** Fail explicitly; pg-boss retains the error and the UI can retry this order. */
export async function handleOrderExtraction(job: PgBoss.Job<OrderExtractionJobData>) {
  let currentStage = "start";
  const stage = (name: string) => {
    currentStage = name;
    console.info(`[order-extraction:${name}]`, { orderId: job.data.orderId, jobId: job.id, stage: name });
  };
  stage("start");
  try {
    return await extract(job, stage);
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown error")
      .replace(/https?:\/\/\S+/g, "[URL]").replace(/Bearer \S+|sk-[\w-]+/gi, "[REDACTED]").slice(0, 2000);
    console.error("[order-extraction:error]", { orderId: job.data.orderId, jobId: job.id,
      stage: currentStage, errorClass: error instanceof Error ? error.name : "Unknown", message });
    assertOrderTransition("processing", "processing_failed");
    await getDb().update(schema.orders).set({ status: "processing_failed" })
      .where(and(eq(schema.orders.id, job.data.orderId), eq(schema.orders.status, "processing")));
    throw new Error(`Order extraction failed at ${currentStage}: ${message}`);
  }
}
