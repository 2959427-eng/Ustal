import { authorTitle } from "../lib/order-text.js";
import type { FastifyInstance } from "fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { createResponseSchema, updateResponseSchema } from "@ustal/validation";
import { notifyUser } from "../lib/notify.js";
import { areBlocked, blockedCounterparts } from "../lib/blocks.js";
import { isContactAccessOpen } from "../lib/contact-access.js";

/**
 * Отклики (docs/api.md «Заказы», docs/data-model.md `responses`). Executor-
 * роль: любой пользователь, кроме автора заказа. Один активный отклик на
 * пару (order, executor) — обеспечено частичным unique index'ом в БД
 * (`responses_active_unique`, WHERE status = 'active'), а не только
 * проверкой в коде: гонка параллельных запросов должна ловиться на уровне
 * БД, а не полагаться на TOCTOU-проверку в JS.
 *
 * Idempotency-Key не требуется (docs/api.md: «нет, но max 1 активный per
 * user проверяется в транзакции») — в отличие от `POST /orders`/`POST
 * /profile/inputs`, здесь нет AI-вызова, который нельзя было бы случайно
 * продублировать; повторный POST без правок тела просто получит 409 от
 * уникального индекса.
 */
export default async function responsesRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/orders/:id/responses", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const body = createResponseSchema.parse(request.body);

    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    const author = await db.query.users.findFirst({ where: eq(schema.users.id, order.authorId), columns: { status: true } });
    if (author?.status !== "active") {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (await areBlocked(db, order.authorId, request.userId)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }
    if (order.authorId === request.userId) {
      return reply
        .code(403)
        .send({ error: { code: "forbidden", message: "Нельзя откликнуться на собственный заказ" } });
    }
    // "published" и "negotiating" оба принимают новые отклики (Фаза 6:
    // множественные assignments без счётчиков — автор может продолжать
    // выбирать исполнителей даже после того, как уже выбрал кого-то, а
    // значит новые желающие тоже должны иметь возможность откликнуться).
    // Единственное, что блокирует новые отклики — явное закрытие заказа
    // (orders/{id}/close, см. assignments.ts), а не сам факт первого выбора.
    if (!["published", "negotiating"].includes(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Заказ не принимает отклики в статусе "${order.status}"` },
      });
    }

    // Встречная цена возможна только если заказчик разрешил её при создании заказа.
    if (body.offeredPriceMinor != null && !order.acceptsPriceOffers) {
      return reply.code(400).send({
        error: { code: "price_offers_disabled", message: "Заказчик не принимает предложения с другой ценой" },
      });
    }

    let created: typeof schema.responses.$inferSelect | undefined;
    try {
      [created] = await db
        .insert(schema.responses)
        .values({
          orderId,
          executorId: request.userId,
          offeredPriceMinor: body.offeredPriceMinor ?? null,
          comment: body.comment ?? null,
          availabilityText: body.availabilityText ?? null,
        })
        .returning();
    } catch (err) {
      // drizzle-orm's postgres-js driver wraps the real PostgresError in a
      // DrizzleQueryError — the Postgres error code lives on `.cause.code`,
      // not on the thrown error itself (см. node_modules/drizzle-orm/errors.ts).
      const pgCode = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
      if (pgCode === "23505") {
        return reply.code(409).send({
          error: { code: "already_responded", message: "У вас уже есть активный отклик на этот заказ" },
        });
      }
      throw err;
    }
    if (!created) throw new Error("Failed to create response");

    await notifyUser(order.authorId, "new_response", {
      orderId,
      responseId: created.id,
      title: "Новый отклик на ваш заказ",
      body: (authorTitle(order.sourceText) ?? order.normalizedTitle) ? `Откликнулись на «${(authorTitle(order.sourceText) ?? order.normalizedTitle)}»` : "У вас новый отклик",
    });

    return reply.code(201).send({
      id: created.id,
      orderId: created.orderId,
      status: created.status,
      offeredPriceMinor: created.offeredPriceMinor,
      comment: created.comment,
      availabilityText: created.availabilityText,
      createdAt: created.createdAt,
    });
  });

  app.get("/orders/:id/responses", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      // Как и GET /orders/{id}: чужой заказ скрывается за 404, не за 403.
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }

    const responseRows = await db.query.responses.findMany({
      // Отозванные отклики остаются в БД для истории, но заказчику не показываются.
      where: and(eq(schema.responses.orderId, orderId), ne(schema.responses.status, "withdrawn")),
      orderBy: (t, { desc }) => desc(t.createdAt),
    });

    const [executorProfiles, unlocks, assignments] = await Promise.all([
      db.query.userProfiles.findMany({
        where: (t, { inArray: inA }) => inA(t.userId, responseRows.map((r) => r.executorId)),
      }),
      db.query.contactUnlocks.findMany({ where: eq(schema.contactUnlocks.orderId, orderId) }),
      db.query.orderAssignments.findMany({ where: eq(schema.orderAssignments.orderId, orderId) }),
    ]);
    const profileByUser = new Map(executorProfiles.map((p) => [p.userId, p]));
    const unlockedExecutorIds = new Set(unlocks.map((u) => u.executorId));
    // Полный assignment (не только status) — id нужен клиенту-автору для
    // POST /orders/{id}/assignments/{assignmentId}/complete и .../not-completed.
    const assignmentByExecutor = new Map(assignments.map((a) => [a.executorId, a]));
    // Заблокированные не показываются кандидатами; исключение — исполнитель с назначением (в работе/завершено):
    // заказчик должен иметь возможность довести заказ до «Выполнено / Не выполнено».
    const blocked = await blockedCounterparts(db, request.userId);
    const visibleRows = responseRows.filter((r) => !blocked.has(r.executorId) || assignmentByExecutor.has(r.executorId));

    return reply.send({
      items: visibleRows.map((r) => {
        const assignment = assignmentByExecutor.get(r.executorId);
        return {
          id: r.id,
          executorId: r.executorId,
          executorName: profileByUser.get(r.executorId)?.name ?? null,
          executorAvatarMediaId: profileByUser.get(r.executorId)?.avatarMediaId ?? null,
          status: r.status,
          offeredPriceMinor: r.offeredPriceMinor,
          comment: r.comment,
          availabilityText: r.availabilityText,
          createdAt: r.createdAt,
          isContactUnlocked:
            unlockedExecutorIds.has(r.executorId) &&
            !blocked.has(r.executorId) &&
            isContactAccessOpen({ orderStatus: order.status, assignmentStatus: assignment?.status, responseStatus: r.status }),
          assignmentId: assignment?.id ?? null,
          assignmentStatus: assignment?.status ?? null,
          // Отметка исполнителя "работа выполнена"/"не получилось" — только
          // сигнал заказчику рядом с кнопками «Выполнено»/«Не выполнено»,
          // сама она заказ не завершает (routes/assignments.ts
          // executor-report-*).
          executorReport: assignment?.executorReport ?? null,
          executorReportAt: assignment?.executorReportAt ?? null,
        };
      }),
    });
  });

  app.patch("/responses/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateResponseSchema.parse(request.body);
    const guard = await loadEditableResponse(db, id, request.userId);
    if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });
    if (body.offeredPriceMinor != null && !guard.acceptsPriceOffers) {
      return reply.code(400).send({
        error: { code: "price_offers_disabled", message: "Заказчик не принимает предложения с другой ценой" },
      });
    }

    const updates: Partial<typeof schema.responses.$inferInsert> = { updatedAt: new Date() };
    if (body.offeredPriceMinor !== undefined) updates.offeredPriceMinor = body.offeredPriceMinor;
    if (body.comment !== undefined) updates.comment = body.comment;
    if (body.availabilityText !== undefined) updates.availabilityText = body.availabilityText;

    // Race-фикс (2026-09-22, второй security-проход): UPDATE был безусловным,
    // без замка и без повторной проверки статуса — в отличие от DELETE ниже,
    // который уже берёт SELECT ... FOR UPDATE. PATCH, проигравший гонку с
    // параллельным DELETE (withdraw), мог молча записать правки поверх уже
    // отозванного отклика. Теперь: тот же замок + повторная проверка status
    // под ним, и сам UPDATE условный (WHERE status='active').
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM responses WHERE id = ${id} FOR UPDATE`);
      const [current] = await tx.select().from(schema.responses).where(eq(schema.responses.id, id));
      if (!current || current.status !== "active") return undefined;
      const [row] = await tx
        .update(schema.responses)
        .set(updates)
        .where(and(eq(schema.responses.id, id), eq(schema.responses.status, "active")))
        .returning();
      return row;
    });
    if (!updated) {
      return reply.code(409).send({ error: { code: "invalid_status", message: "Отклик уже нельзя изменить" } });
    }

    return reply.send({
      id: updated.id,
      status: updated.status,
      offeredPriceMinor: updated.offeredPriceMinor,
      comment: updated.comment,
      availabilityText: updated.availabilityText,
    });
  });

  app.delete("/responses/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const guard = await loadEditableResponse(db, id, request.userId);
    if ("error" in guard) return reply.code(guard.status).send({ error: guard.error });

    // Блокируем строку отклика: заказчик выбирает исполнителя под тем же
    // FOR UPDATE, поэтому «выбрали» и «отозвал» не могут пройти одновременно.
    const withdrawn = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM responses WHERE id = ${id} FOR UPDATE`);
      const [current] = await tx.select().from(schema.responses).where(eq(schema.responses.id, id));
      if (!current || current.status !== "active") return "invalid_status" as const;
      const [assignment] = await tx
        .select({ id: schema.orderAssignments.id })
        .from(schema.orderAssignments)
        .where(and(eq(schema.orderAssignments.orderId, current.orderId), eq(schema.orderAssignments.executorId, current.executorId)));
      if (assignment) return "already_selected" as const;
      await tx
        .update(schema.responses)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(eq(schema.responses.id, id));
      return "ok" as const;
    });
    if (withdrawn === "already_selected") {
      return reply.code(409).send({
        error: { code: "already_selected", message: "Вас уже выбрали по этому заказу — отклик отозвать нельзя" },
      });
    }
    if (withdrawn === "invalid_status") {
      return reply.code(409).send({ error: { code: "invalid_status", message: "Отклик уже нельзя отозвать" } });
    }

    return reply.code(204).send();
  });
}

/**
 * Общая проверка для PATCH/DELETE /responses/{id} (docs/api.md: «только до
 * выбора кандидата или закрытия заказа»): владелец, отклик ещё активен,
 * заказ не закрыт/не завершён, и по этой конкретной паре (order, executor)
 * ещё нет order_assignment (после выбора кандидата править/отзывать отклик
 * уже поздно — это переговоры, а не заявка).
 */
async function loadEditableResponse(
  db: ReturnType<typeof getDb>,
  responseId: string,
  userId: string,
): Promise<{ id: string; acceptsPriceOffers: boolean } | { status: number; error: { code: string; message: string } }> {
  const response = await db.query.responses.findFirst({ where: eq(schema.responses.id, responseId) });
  if (!response || response.executorId !== userId) {
    return { status: 404, error: { code: "not_found", message: "Отклик не найден" } };
  }
  if (response.status !== "active") {
    return { status: 409, error: { code: "invalid_status", message: `Отклик в статусе "${response.status}" нельзя изменить` } };
  }
  const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, response.orderId) });
  if (!order || !["published", "negotiating"].includes(order.status)) {
    return {
      status: 409,
      error: { code: "invalid_status", message: "Заказ закрыт или отменён — отклик больше нельзя менять" },
    };
  }
  const assignment = await db.query.orderAssignments.findFirst({
    where: and(eq(schema.orderAssignments.orderId, response.orderId), eq(schema.orderAssignments.executorId, userId)),
  });
  if (assignment) {
    return {
      status: 409,
      error: { code: "already_selected", message: "Вас уже выбрали по этому заказу — отклик больше нельзя менять" },
    };
  }
  return { id: response.id, acceptsPriceOffers: order.acceptsPriceOffers };
}
