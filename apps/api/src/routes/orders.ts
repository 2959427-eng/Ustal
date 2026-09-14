import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getSql, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { getBoss, JOB_TYPES } from "@ustal/queue";
import { createOrderSchema, editOrderTranscriptSchema } from "@ustal/validation";
import { withIdempotency } from "../lib/idempotency.js";

/**
 * Заказы (docs/api.md, docs/matching.md пайплайн заказа). `POST /orders`
 * создаёт draft и сразу переводит его в processing (draft->processing —
 * тривиальный переход, не требует ожидания worker'а), затем ставит job на
 * extraction. Публикация — отдельное явное действие автора, не автоматическая
 * (см. docs/api.md: «только из processing→published при moderation_status =
 * allow»; allow_with_warning тоже разрешает публикацию — предупреждение
 * показывается автору, а не блокирует его, в отличие от manual_review/reject).
 *
 * Голосовой заказ переиспользует `media`/`order_media` вместо отдельной
 * колонки audio_media_id на orders: аудио прикрепляется как order_media с
 * media.kind='audio' (position -1, чтобы не путаться с порядком фото).
 */
export default async function ordersRoutes(app: FastifyInstance) {
  const db = getDb();

  // Covers terminal jobs from older workers and jobs expired after a worker crash.
  async function reconcileFailure(orderId: string) {
    await getSql()`update orders o set status='processing_failed'
      where o.id=${orderId} and o.status='processing' and o.moderation_status='pending'
      and (select j.state::text from pgboss.job j where j.name='order_extraction'
        and j.data->>'orderId'=o.id::text order by j.createdon desc limit 1)='failed'`;
  }

  app.post("/orders/:id/retry", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const owned = await db.query.orders.findFirst({ where: and(eq(schema.orders.id, id), eq(schema.orders.authorId, request.userId)) });
    if (!owned) return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    await reconcileFailure(id);
    const boss = await getBoss();
    assertOrderTransition("processing_failed", "processing");
    const queued = await getSql().begin(async (tx) => {
      const claimed = await tx`update orders set status='processing', moderation_status='pending'
        where id=${id} and status='processing_failed' returning id`;
      if (!claimed.length) return false;
      const jobId = await boss.send(JOB_TYPES.ORDER_EXTRACTION, { orderId: id }, {
        retryLimit: 0, expireInSeconds: 120,
        db: { executeSql: async (text, values) => {
          const rows = await tx.unsafe(text, values);
          return { rows, rowCount: rows.count };
        } },
      });
      if (!jobId) throw new Error("Order extraction was not queued");
      return true;
    });
    if (!queued) return reply.code(409).send({ error: { code: "invalid_status", message: "Заказ уже обрабатывается или завершён" } });
    return reply.code(202).send({ orderId: id, status: "processing" });
  });

  app.post("/orders", { preHandler: app.authenticate }, async (request, reply) => {
    await withIdempotency(request, reply, "POST /orders", async (): Promise<{
      status: number;
      body: Record<string, unknown>;
    }> => {
      const body = createOrderSchema.parse(request.body);

      const authorProfile = await db.query.userProfiles.findFirst({
        where: eq(schema.userProfiles.userId, request.userId),
      });
      if (!authorProfile) {
        return { status: 404, body: { error: { code: "not_found", message: "Профиль пользователя не найден" } } };
      }

      const mediaIdsToCheck = [...body.mediaIds, ...(body.audioMediaId ? [body.audioMediaId] : [])];
      if (mediaIdsToCheck.length > 0) {
        const owned = await db.query.media.findMany({
          where: and(inArray(schema.media.id, mediaIdsToCheck), eq(schema.media.ownerId, request.userId)),
        });
        if (owned.length !== mediaIdsToCheck.length) {
          return {
            status: 400,
            body: { error: { code: "media_not_found", message: "Один или несколько mediaId не найдены или принадлежат другому пользователю" } },
          };
        }
      }

      // Пауза «Проверка транскрипции» (экран 9/11, claude/pipeline-split-design.md):
      // voice-заказ сначала уходит только на STT (ORDER_TRANSCRIBE) и ждёт
      // подтверждения — sourceText остаётся пустым до confirm-transcript.
      // text-заказ — без изменений, sourceText заполнен сразу, extraction сразу.
      const [order] = await db
        .insert(schema.orders)
        .values({
          authorId: request.userId,
          cityId: authorProfile.cityId,
          sourceText: body.inputType === "text" ? (body.text ?? null) : null,
          sourceStatus: body.inputType === "voice" ? "transcribing" : "confirmed",
          priceMinor: body.priceMinor ?? null,
          status: "draft",
        })
        .returning();
      if (!order) throw new Error("Failed to create order");

      const mediaRows: (typeof schema.orderMedia.$inferInsert)[] = body.mediaIds.map((mediaId, position) => ({
        orderId: order.id,
        mediaId,
        position,
      }));
      if (body.inputType === "voice" && body.audioMediaId) {
        mediaRows.push({ orderId: order.id, mediaId: body.audioMediaId, position: -1 });
      }
      if (mediaRows.length > 0) {
        await db.insert(schema.orderMedia).values(mediaRows);
      }

      assertOrderTransition("draft", "processing");
      await db.update(schema.orders).set({ status: "processing" }).where(eq(schema.orders.id, order.id));

      try {
      const boss = await getBoss();
      if (body.inputType === "voice") {
        await boss.send(JOB_TYPES.ORDER_TRANSCRIBE, { orderId: order.id });
      } else {
        await boss.send(JOB_TYPES.ORDER_EXTRACTION, { orderId: order.id }, { retryLimit: 0, expireInSeconds: 120 });
      }
      } catch (error) {
        await db.update(schema.orders).set({ status: "processing_failed" }).where(eq(schema.orders.id, order.id));
        throw error;
      }

      return { status: 201, body: { orderId: order.id, status: "processing" } };
    });
  });

  app.get("/orders/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (!order || order.authorId !== request.userId) {
      // Не раскрываем существование чужого заказа под чужим ID.
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    await reconcileFailure(id);
    const refreshed = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (refreshed) order.status = refreshed.status;

    const [requirements, latestExtraction, mediaRows] = await Promise.all([
      db.query.orderRequirements.findMany({ where: eq(schema.orderRequirements.orderId, order.id) }),
      db.query.orderAiExtractions.findFirst({
        where: eq(schema.orderAiExtractions.orderId, order.id),
        orderBy: (t, { desc }) => desc(t.createdAt),
      }),
      db.query.orderMedia.findMany({ where: eq(schema.orderMedia.orderId, order.id) }),
    ]);

    const rawResult = latestExtraction?.rawResult as { contextualChips?: string[] } | undefined;

    return reply.send({
      id: order.id,
      status: order.status,
      cityId: order.cityId,
      normalizedTitle: order.normalizedTitle,
      normalizedDescription: order.normalizedDescription,
      priceMinor: order.priceMinor,
      currency: order.currency,
      riskLevel: order.riskLevel,
      moderationStatus: order.moderationStatus,
      createdAt: order.createdAt,
      publishedAt: order.publishedAt,
      contextualChips: rawResult?.contextualChips ?? [],
      requirements,
      photoMediaIds: mediaRows.filter((m) => m.position >= 0).map((m) => m.mediaId),
      // Пауза «Проверка транскрипции» (экран 9/11) — видно только автору,
      // ownership уже проверен выше.
      sourceStatus: order.sourceStatus,
      transcript: order.transcript,
    });
  });

  app.patch("/orders/:id/transcript", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = editOrderTranscriptSchema.parse(request.body);

    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (order.sourceStatus !== "awaiting_review") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Транскрипт нельзя редактировать в статусе "${order.sourceStatus}"` },
      });
    }

    const [updated] = await db
      .update(schema.orders)
      .set({ sourceText: body.transcriptCorrected })
      .where(eq(schema.orders.id, id))
      .returning();
    return reply.send({ id: updated!.id, transcript: updated!.transcript, sourceText: updated!.sourceText });
  });

  app.post("/orders/:id/confirm-transcript", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await withIdempotency(request, reply, "POST /orders/:id/confirm-transcript", async (): Promise<{
      status: number;
      body: Record<string, unknown>;
    }> => {
      const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
      if (!order || order.authorId !== request.userId) {
        return { status: 404 as const, body: { error: { code: "not_found", message: "Заказ не найден" } } };
      }
      if (order.sourceStatus !== "awaiting_review") {
        return {
          status: 409 as const,
          body: {
            error: { code: "invalid_status", message: `Нельзя подтвердить транскрипт в статусе "${order.sourceStatus}"` },
          },
        };
      }

      // sourceText мог уже быть поправлен через PATCH .../transcript — если
      // нет, используем сырой результат STT как есть.
      const sourceText = order.sourceText ?? order.transcript;
      if (!sourceText) {
        return {
          status: 409 as const,
          body: { error: { code: "invalid_status", message: "Нет текста транскрипта для подтверждения" } },
        };
      }

      await db
        .update(schema.orders)
        .set({ sourceText, sourceStatus: "confirmed" })
        .where(eq(schema.orders.id, id));

      const boss = await getBoss();
      await boss.send(JOB_TYPES.ORDER_EXTRACTION, { orderId: order.id });

      return { status: 202 as const, body: { orderId: order.id, status: "processing" as const } };
    });
  });

  app.post("/orders/:id/publish", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (order.moderationStatus !== "allow" && order.moderationStatus !== "allow_with_warning") {
      return reply.code(409).send({
        error: {
          code: "moderation_not_passed",
          message: `Заказ нельзя опубликовать: статус модерации "${order.moderationStatus}"`,
        },
      });
    }
    if (!canTransitionOrderPublic(order.status, "published")) {
      return reply
        .code(409)
        .send({ error: { code: "invalid_status", message: `Нельзя опубликовать заказ из статуса "${order.status}"` } });
    }

    assertOrderTransition(order.status as never, "published");
    const [updated] = await db
      .update(schema.orders)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.orders.id, order.id))
      .returning();

    // Публикация — единственный триггер matching (docs/matching.md §13.5):
    // заказ должен появиться в лентах кандидатов сразу после публикации, а не
    // ждать какого-то отдельного шага.
    const boss = await getBoss();
    await boss.send(JOB_TYPES.MATCHING_RUN, { orderId: order.id });

    return reply.send({ id: updated?.id, status: updated?.status, publishedAt: updated?.publishedAt });
  });

  app.post("/orders/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, id) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (!canTransitionOrderPublic(order.status, "cancelled")) {
      return reply
        .code(409)
        .send({ error: { code: "invalid_status", message: `Нельзя отменить заказ из статуса "${order.status}"` } });
    }

    assertOrderTransition(order.status as never, "cancelled");
    await db.update(schema.orders).set({ status: "cancelled" }).where(eq(schema.orders.id, order.id));

    return reply.code(204).send();
  });
}

function canTransitionOrderPublic(from: string, to: string): boolean {
  // Тонкая обёртка вокруг domain-guard'а для читаемого 409 вместо throw.
  try {
    assertOrderTransition(from as never, to as never);
    return true;
  } catch {
    return false;
  }
}
