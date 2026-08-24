import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { assertOrderTransition } from "@ustal/domain";
import { createAssignmentSchema, notCompletedSchema } from "@ustal/validation";
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

  app.post(
    "/orders/:id/assignments/:assignmentId/complete",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const guard = await loadOwnedSelectedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId);
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      await db
        .update(schema.orderAssignments)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(schema.orderAssignments.id, guard.assignment.id));

      // "Открывает форму оценки на клиенте" (docs/api.md) — сам отзыв
      // создаётся отдельным вызовом POST /reviews (Фаза 7, routes/reviews.ts),
      // который проверяет именно наличие completed order_assignment между
      // парой. Положительный сигнал для matching (совпадение с похожей
      // выполненной работой, packages/matching/src/scoring.ts
      // similarCompletedWork) не требует отдельной записи здесь: worker
      // (apps/worker/src/handlers/matching-run.ts) уже читает
      // order_assignments.status = 'completed' напрямую при каждом новом
      // matching_run.
      await notifyUser(guard.assignment.executorId, "assignment_completed", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Заказ отмечен как выполненный",
        body: guard.order.normalizedTitle
          ? `«${guard.order.normalizedTitle}» отмечен как выполненный — оставьте отзыв друг о друге`
          : "Заказ отмечен как выполненный — оставьте отзыв друг о друге",
      });

      return reply.send({ id: guard.assignment.id, status: "completed" });
    },
  );

  app.post(
    "/orders/:id/assignments/:assignmentId/not-completed",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = notCompletedSchema.parse(request.body);
      const guard = await loadOwnedSelectedAssignment(db, request.params as { id: string; assignmentId: string }, request.userId);
      if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

      await db
        .update(schema.orderAssignments)
        .set({ status: "not_completed", notCompletedReason: body.reason ?? null })
        .where(eq(schema.orderAssignments.id, guard.assignment.id));

      // Намеренно НЕ completedAt — семантически это поле «когда выполнено»,
      // а не «когда закрыт статус». matching не получает позитивный сигнал
      // (docs/api.md): worker считает только status = 'completed', эта ветка
      // никогда им не станет.
      await notifyUser(guard.assignment.executorId, "assignment_not_completed", {
        orderId: guard.order.id,
        assignmentId: guard.assignment.id,
        title: "Заказ отмечен как невыполненный",
        body: guard.order.normalizedTitle
          ? `«${guard.order.normalizedTitle}» отмечен как невыполненный`
          : "Заказ отмечен как невыполненный",
      });

      return reply.send({ id: guard.assignment.id, status: "not_completed" });
    },
  );
}

/**
 * Общая проверка для complete/not-completed: назначение существует,
 * принадлежит указанному заказу, заказ принадлежит вызывающему (автору), и
 * назначение ещё в статусе `selected` (нельзя завершить уже завершённое или
 * отменённое назначение повторно/в другую сторону).
 */
async function loadOwnedSelectedAssignment(
  db: ReturnType<typeof getDb>,
  params: { id: string; assignmentId: string },
  userId: string,
): Promise<
  | { assignment: typeof schema.orderAssignments.$inferSelect; order: typeof schema.orders.$inferSelect }
  | { status: number; error: { code: string; message: string } }
> {
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, params.id) });
  if (!order || order.authorId !== userId) {
    return { status: 404, error: { code: "not_found", message: "Заказ не найден" } };
  }
  const assignment = await db.query.orderAssignments.findFirst({ where: eq(schema.orderAssignments.id, params.assignmentId) });
  if (!assignment || assignment.orderId !== order.id) {
    return { status: 404, error: { code: "not_found", message: "Назначение не найдено" } };
  }
  if (assignment.status !== "selected") {
    return {
      status: 409,
      error: { code: "invalid_status", message: `Назначение уже в статусе "${assignment.status}" — повторное завершение невозможно` },
    };
  }
  return { assignment, order };
}
