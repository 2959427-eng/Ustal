import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { reviewSchema, updateReviewSchema } from "@ustal/validation";

/**
 * Двусторонние отзывы (docs/api.md, docs/data-model.md `reviews`, plan.md
 * Фаза 7). Отзыв привязан не к заказу, а к ПАРЕ пользователей —
 * UNIQUE(from_user_id, to_user_id): повторная совместная работа обновляет
 * существующую запись (rating/text/last_order_id), а не плодит новую. Это
 * сознательное решение модели данных (см. data-model.md), а не сокращение —
 * профиль пользователя показывает один агрегированный отзыв от каждого
 * контрагента, отражающий последнее взаимодействие.
 *
 * Право оставить отзыв проверяется backend'ом, а не клиентом: должен
 * существовать `order_assignments.status = 'completed'` между этой парой по
 * указанному заказу, в любом направлении ролей (автор→исполнитель или
 * исполнитель→автор) — см. loadReviewEligibility ниже.
 */
export default async function reviewsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/reviews", { preHandler: app.authenticate }, async (request, reply) => {
    const body = reviewSchema.parse(request.body);
    if (body.toUserId === request.userId) {
      return reply.code(400).send({ error: { code: "invalid_target", message: "Нельзя оставить отзыв самому себе" } });
    }

    const eligible = await loadReviewEligibility(db, body.orderId, request.userId, body.toUserId);
    if (!eligible) {
      return reply.code(403).send({
        error: {
          code: "not_eligible",
          message: "Отзыв можно оставить только по завершённой совместной работе над этим заказом",
        },
      });
    }

    const existing = await db.query.reviews.findFirst({
      where: and(eq(schema.reviews.fromUserId, request.userId), eq(schema.reviews.toUserId, body.toUserId)),
    });

    if (existing) {
      const [updated] = await db
        .update(schema.reviews)
        .set({ rating: body.rating, text: body.text ?? null, lastOrderId: body.orderId, updatedAt: new Date() })
        .where(eq(schema.reviews.id, existing.id))
        .returning();
      return reply.code(200).send(toReviewResponse(updated));
    }

    const [created] = await db
      .insert(schema.reviews)
      .values({
        fromUserId: request.userId,
        toUserId: body.toUserId,
        lastOrderId: body.orderId,
        rating: body.rating,
        text: body.text ?? null,
      })
      .returning();
    if (!created) throw new Error("Failed to create review");
    return reply.code(201).send(toReviewResponse(created));
  });

  app.patch("/reviews/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateReviewSchema.parse(request.body);

    const existing = await db.query.reviews.findFirst({ where: eq(schema.reviews.id, id) });
    if (!existing || existing.fromUserId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отзыв не найден" } });
    }

    const [updated] = await db
      .update(schema.reviews)
      .set({ rating: body.rating, text: body.text === undefined ? existing.text : body.text, updatedAt: new Date() })
      .where(eq(schema.reviews.id, id))
      .returning();

    return reply.send(toReviewResponse(updated));
  });
}

function toReviewResponse(row: typeof schema.reviews.$inferSelect | undefined) {
  if (!row) throw new Error("Failed to persist review");
  return {
    id: row.id,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    lastOrderId: row.lastOrderId,
    rating: row.rating,
    text: row.text,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Заказ существует, и по нему между `fromUserId` и `toUserId` есть
 * `order_assignments.status = 'completed'` в любом направлении ролей:
 * либо `fromUserId` — автор заказа, а `toUserId` — завершивший работу
 * исполнитель, либо наоборот.
 */
async function loadReviewEligibility(
  db: ReturnType<typeof getDb>,
  orderId: string,
  fromUserId: string,
  toUserId: string,
): Promise<boolean> {
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
  if (!order) return false;

  const executorId = order.authorId === fromUserId ? toUserId : order.authorId === toUserId ? fromUserId : null;
  const authorId = order.authorId;
  if (executorId === null) return false; // ни один из пары не автор этого заказа
  if (authorId !== fromUserId && authorId !== toUserId) return false;

  const completedAssignment = await db.query.orderAssignments.findFirst({
    where: and(
      eq(schema.orderAssignments.orderId, orderId),
      eq(schema.orderAssignments.executorId, executorId),
      eq(schema.orderAssignments.status, "completed"),
    ),
  });
  return !!completedAssignment;
}
