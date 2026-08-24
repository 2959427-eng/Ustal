import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { createAssignmentSchema } from "@ustal/validation";
import { notifyUser } from "../lib/notify.js";

/**
 * «Договорились» и закрытие заказа (docs/api.md, docs/data-model.md
 * `order_assignments`, plan.md Фаза 6). Намеренно НЕТ
 * required_executors_count/confirmed_executors_count (docs/data-model.md —
 * заказ может иметь сколько угодно `order_assignments`, без счётчика в UI):
 * автор выбирает столько исполнителей, сколько нужно, по одному вызову
 * `POST /orders/{id}/assignments` на каждого — множественные назначения на
 * один заказ такая же нормальная ситуация, как и единственное.
 *
 * Первое назначение переводит заказ `published` → `negotiating` (не
 * блокирует новые отклики само по себе — их по-прежнему можно оставлять,
 * пока заказ не закрыт явно, см. `responses.ts`); `POST /orders/{id}/close`
 * — единственное действие, которое блокирует дальнейшие отклики
 * (`orders.status = 'closed'` не входит в допустимые статусы для создания
 * отклика) и транзакционно переводит все ещё активные, но не выбранные
 * отклики в `not_selected` с уведомлением каждому.
 */
export default async function assignmentsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/orders/:id/assignments", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const body = createAssignmentSchema.parse(request.body);

    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (!["published", "negotiating"].includes(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя выбрать исполнителя для заказа в статусе "${order.status}"` },
      });
    }

    const response = await db.query.responses.findFirst({ where: eq(schema.responses.id, body.responseId) });
    if (!response || response.orderId !== orderId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отклик не найден" } });
    }
    if (response.status !== "active") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Отклик в статусе "${response.status}" нельзя выбрать` },
      });
    }

    const unlock = await db.query.contactUnlocks.findFirst({
      where: and(eq(schema.contactUnlocks.orderId, orderId), eq(schema.contactUnlocks.executorId, response.executorId)),
    });
    if (!unlock) {
      return reply.code(409).send({
        error: {
          code: "contact_not_unlocked",
          message: "Сначала нужно раскрыть контакт исполнителя (POST /orders/{id}/contact-unlocks)",
        },
      });
    }

    let created: typeof schema.orderAssignments.$inferSelect | undefined;
    try {
      [created] = await db
        .insert(schema.orderAssignments)
        .values({ orderId, executorId: response.executorId, responseId: response.id })
        .returning();
    } catch (err) {
      // См. docs/architecture.md §5 п.15: код ошибки Postgres у drizzle-orm
      // postgres-js лежит на err.cause.code, а не на err.code напрямую.
      const pgCode = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
      if (pgCode === "23505") {
        return reply.code(409).send({ error: { code: "already_selected", message: "Этот исполнитель уже выбран по заказу" } });
      }
      throw err;
    }
    if (!created) throw new Error("Failed to create order_assignment");

    if (order.status === "published") {
      assertOrderTransition("published", "negotiating");
      await db.update(schema.orders).set({ status: "negotiating" }).where(eq(schema.orders.id, orderId));
    }

    await notifyUser(response.executorId, "selected", {
      orderId,
      assignmentId: created.id,
      title: "Договорились!",
      body: order.normalizedTitle ? `Вас выбрали для «${order.normalizedTitle}»` : "Вас выбрали для заказа",
    });

    return reply.code(201).send({
      id: created.id,
      orderId: created.orderId,
      executorId: created.executorId,
      status: created.status,
      selectedAt: created.selectedAt,
    });
  });

  app.post("/orders/:id/close", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (!["published", "negotiating"].includes(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Нельзя закрыть заказ в статусе "${order.status}"` },
      });
    }

    assertOrderTransition(order.status as "published" | "negotiating", "closed");

    const notSelected = await db.transaction(async (tx) => {
      const assignments = await tx.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.orderId, orderId) });
      const selectedExecutorIds = assignments.map((a) => a.executorId);

      const activeResponses = await tx.query.responses.findMany({
        where: and(eq(schema.responses.orderId, orderId), eq(schema.responses.status, "active")),
      });
      const toMarkNotSelected = activeResponses.filter((r) => !selectedExecutorIds.includes(r.executorId));

      if (toMarkNotSelected.length > 0) {
        await tx
          .update(schema.responses)
          .set({ status: "not_selected", updatedAt: new Date() })
          .where(
            and(
              eq(schema.responses.orderId, orderId),
              eq(schema.responses.status, "active"),
              inArray(
                schema.responses.id,
                toMarkNotSelected.map((r) => r.id),
              ),
            ),
          );
      }

      await tx.update(schema.orders).set({ status: "closed", closedAt: new Date() }).where(eq(schema.orders.id, orderId));

      return toMarkNotSelected;
    });

    // Уведомления — вне транзакции (создают свои строки + ставят задачи в
    // pg-boss; не должны откатывать уже зафиксированное закрытие заказа при
    // сбое доставки одного уведомления).
    for (const r of notSelected) {
      await notifyUser(r.executorId, "not_selected", {
        orderId,
        responseId: r.id,
        title: "Заказ закрыт",
        body: order.normalizedTitle
          ? `На этот раз не сложилось: «${order.normalizedTitle}»`
          : "На этот раз выбрали другого исполнителя",
      });
    }

    return reply.send({ id: orderId, status: "closed", notSelectedCount: notSelected.length });
  });
}
