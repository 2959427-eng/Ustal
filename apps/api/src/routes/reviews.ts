import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { rateOrderSchema } from "@ustal/validation";

/**
 * Оценка после выполненного заказа: обе стороны оценивают друг друга 1–5
 * (или пропуск, rating = null) — заказчик исполнителя и исполнитель
 * заказчика, независимо друг от друга. Без текста. Запись одна на (заказ,
 * автор оценки) — `order_ratings_order_from_unique` — и неизменна: один
 * пользователь не может дважды оценить другого по одному заказу. `toRole`
 * определяет, в какой из двух независимых рейтингов (см. lib/reputation.ts)
 * попадёт оценка. Оценивать могут только реальные участники завершённого
 * заказа (loadRatingContext). После оценки заказ/отклик уходит в архив
 * своей стороны (lib/reputation.ts customerOrderArchived/
 * executorResponseArchived).
 */
export default async function ratingsRoutes(app: FastifyInstance) {
  const db = getDb();

  /**
   * Заказ + выполненное назначение + кого оценивает текущий пользователь.
   * null, если пользователь не участник (не автор и не исполнитель).
   */
  async function loadRatingContext(orderId: string, userId: string) {
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order) return null;
    const assignment = await db.query.orderAssignments.findFirst({
      where: and(eq(schema.orderAssignments.orderId, orderId), eq(schema.orderAssignments.status, "completed")),
    });
    if (!assignment) return null;
    const isAuthor = order.authorId === userId;
    if (!isAuthor && assignment.executorId !== userId) return null;
    return {
      order,
      targetUserId: isAuthor ? assignment.executorId : order.authorId,
      targetRole: isAuthor ? ("executor" as const) : ("customer" as const),
    };
  }

  // Состояние «Оценить» для текущего пользователя по заказу. RatingCard общий
  // для обеих сторон и монтируется всегда; targetRole подсказывает карточке,
  // кого именно сейчас оценивает пользователь (передаётся только при pending).
  app.get("/orders/:id/rating", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ctx = await loadRatingContext(id, request.userId);
    if (!ctx) return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    const mine = await db.query.orderRatings.findFirst({
      where: and(eq(schema.orderRatings.orderId, id), eq(schema.orderRatings.fromUserId, request.userId)),
    });
    const pending = ctx.order.status === "completed" && !mine;
    return reply.send(pending ? { pending, targetRole: ctx.targetRole } : { pending });
  });

  app.post("/orders/:id/rating", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = rateOrderSchema.parse(request.body);

    const ctx = await loadRatingContext(id, request.userId);
    if (!ctx) return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    if (ctx.order.status !== "completed") {
      return reply.code(409).send({ error: { code: "not_rateable", message: "Оценить можно только выполненный заказ" } });
    }

    const [created] = await db
      .insert(schema.orderRatings)
      .values({
        orderId: id,
        fromUserId: request.userId,
        toUserId: ctx.targetUserId,
        toRole: ctx.targetRole,
        rating: body.rating,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      return reply.code(409).send({ error: { code: "already_rated", message: "Вы уже оценили этот заказ" } });
    }
    return reply.code(201).send({ orderId: id, skipped: created.rating === null });
  });
}
