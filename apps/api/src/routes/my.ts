import { authorTitle } from "../lib/order-text.js";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { customerOrderArchived, executorResponseArchived } from "../lib/reputation.js";
import { isContactAccessOpen } from "../lib/contact-access.js";
import { blockedCounterparts } from "../lib/blocks.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function pagination(query: unknown) {
  const q = query as { limit?: string; offset?: string };
  return {
    limit: Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT)),
    offset: Math.max(0, Number(q.offset) || 0),
  };
}

/**
 * «Мои списки» (docs/api.md «Лента и мои списки»): свои заказы (роль
 * заказчика) и свои отклики (роль исполнителя) — то же единое понятие
 * аккаунта без выбора роли, что и во всём остальном API (docs/architecture.md
 * §2). Ни здесь, ни в /feed нет агрегированных чисел исполнителей в
 * payload'ах, адресованных исполнителям (architecture.md §5 п.6).
 */
export default async function myRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/my/orders", { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, offset } = pagination(request.query);
    const rows = await db.query.orders.findMany({
      // Удалённые (cancelled) заказы в списке не показываем; в БД остаются для истории.
      where: and(eq(schema.orders.authorId, request.userId), ne(schema.orders.status, "cancelled")),
      orderBy: (t, { desc: d }) => [d(t.createdAt), d(t.id)],
      limit,
      offset,
    });
    const media = rows.length ? await db.query.orderMedia.findMany({
      where: inArray(schema.orderMedia.orderId, rows.map((o) => o.id)),
      orderBy: (t, { asc }) => asc(t.position),
    }) : [];
    // Счётчик активных откликов: отозванные (withdrawn) не считаются.
    const counts = rows.length
      ? await db
          .select({ orderId: schema.responses.orderId, n: sql<number>`count(*)::int` })
          .from(schema.responses)
          .where(and(inArray(schema.responses.orderId, rows.map((o) => o.id)), eq(schema.responses.status, "active")))
          .groupBy(schema.responses.orderId)
      : [];
    const activeByOrder = new Map(counts.map((c) => [c.orderId, c.n]));
    const myRatings = rows.length
      ? await db.query.orderRatings.findMany({
          where: and(eq(schema.orderRatings.fromUserId, request.userId), inArray(schema.orderRatings.orderId, rows.map((o) => o.id))),
        })
      : [];
    const ratedOrderIds = new Set(myRatings.map((r) => r.orderId));
    return reply.send({
      items: rows.map((o) => ({
        id: o.id,
        activeResponsesCount: activeByOrder.get(o.id) ?? 0,
        photoMediaIds: media.filter((m) => m.orderId === o.id && m.position >= 0).map((m) => m.mediaId),
        status: o.status,
        // «Оценить»: заказ выполнен, а моя оценка ещё не поставлена и не пропущена.
        ratingPending: o.status === "completed" && !ratedOrderIds.has(o.id),
        archived: customerOrderArchived(o.status, ratedOrderIds.has(o.id)),
        moderationStatus: o.moderationStatus,
        normalizedTitle: authorTitle(o.sourceText) ?? o.normalizedTitle,
        priceMinor: o.priceMinor,
        currency: o.currency,
        createdAt: o.createdAt,
        publishedAt: o.publishedAt,
        closedAt: o.closedAt,
      })),
      limit,
      offset,
    });
  });

  app.get("/my/responses", { preHandler: app.authenticate, schema: { querystring: { type: "object", properties: { orderId: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } } } } }, async (request, reply) => {
    const { limit, offset } = pagination(request.query);
    const { orderId } = request.query as { orderId?: string };
    const rows = await db.query.responses.findMany({
      where: and(eq(schema.responses.executorId, request.userId), orderId ? eq(schema.responses.orderId, orderId) : undefined),
      orderBy: (t, { desc: d }) => [d(t.createdAt), d(t.id)],
      limit,
      offset,
    });

    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const orderRows = orderIds.length > 0
      ? await db.query.orders.findMany({ where: (t, { inArray }) => inArray(t.id, orderIds) })
      : [];
    const orderById = new Map(orderRows.map((o) => [o.id, o]));

    const unlocks = orderIds.length > 0
      ? await db.query.contactUnlocks.findMany({
          where: (t, { inArray, and: a, eq: e }) => a(inArray(t.orderId, orderIds), e(t.executorId, request.userId)),
        })
      : [];
    const unlockedOrderIds = new Set(unlocks.map((u) => u.orderId));

    // Добавление: assignmentStatus и orderAuthorId — исполнителю нужно знать,
    // выбрали ли его и завершена ли работа (чтобы показать «Отметить
    // выполнено» на своей стороне и открыть форму отзыва — POST /reviews
    // требует toUserId, а до этого поля у мобильного клиента исполнителя не
    // было способа узнать id автора заказа, не имея доступа к GET /orders/{id}
    // чужого заказа). Тот же паттерн, что и unlocks/orderById выше.
    const assignments = orderIds.length > 0
      ? await db.query.orderAssignments.findMany({
          where: (t, { inArray, and: a, eq: e }) => a(inArray(t.orderId, orderIds), e(t.executorId, request.userId)),
        })
      : [];
    const assignmentStatusByOrderId = new Map(assignments.map((a) => [a.orderId, a.status]));
    // Полный assignment — исполнителю нужен его id, чтобы отметить
    // "работа выполнена"/"не получилось" (POST .../executor-report-*, см.
    // routes/assignments.ts), а executorReport/executorReportAt — чтобы
    // показать, что отметка уже отправлена и мы ждём подтверждения заказчика.
    const assignmentByOrderId = new Map(assignments.map((a) => [a.orderId, a]));
    // Упрощение рейтинга (2026-09-22): исполнитель заказчика больше не
    // оценивает, поэтому здесь больше нет ни ratingPending, ни зависимости
    // архивации от orderRatings — см. lib/reputation.ts executorResponseArchived.
    const blocked = await blockedCounterparts(db, request.userId);

    return reply.send({
      items: rows.map((r) => {
        const order = orderById.get(r.orderId);
        return {
          id: r.id,
          orderId: r.orderId,
          orderTitle: authorTitle(order?.sourceText) ?? order?.normalizedTitle ?? null,
          orderStatus: order?.status ?? null,
          orderAuthorId: order?.authorId ?? null,
          status: r.status,
          offeredPriceMinor: r.offeredPriceMinor,
          comment: r.comment,
          availabilityText: r.availabilityText,
          createdAt: r.createdAt,
          // Раскрытие — лишь история; кнопки связи показываем, только пока отношения живые.
          isContactUnlocked:
            unlockedOrderIds.has(r.orderId) &&
            !!order &&
            !blocked.has(order.authorId) &&
            isContactAccessOpen({
              orderStatus: order.status,
              assignmentStatus: assignmentStatusByOrderId.get(r.orderId),
              responseStatus: r.status,
            }),
          assignmentStatus: assignmentStatusByOrderId.get(r.orderId) ?? null,
          assignmentId: assignmentByOrderId.get(r.orderId)?.id ?? null,
          executorReport: assignmentByOrderId.get(r.orderId)?.executorReport ?? null,
          executorReportAt: assignmentByOrderId.get(r.orderId)?.executorReportAt ?? null,
          archived: executorResponseArchived(
            order?.status ?? null,
            assignmentStatusByOrderId.get(r.orderId) ?? null,
            r.status,
          ),
        };
      }),
      limit,
      offset,
    });
  });
}
