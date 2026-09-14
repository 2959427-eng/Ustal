import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

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
      where: eq(schema.orders.authorId, request.userId),
      orderBy: (t, { desc: d }) => d(t.createdAt),
      limit,
      offset,
    });
    const media = rows.length ? await db.query.orderMedia.findMany({
      where: inArray(schema.orderMedia.orderId, rows.map((o) => o.id)),
      orderBy: (t, { asc }) => asc(t.position),
    }) : [];
    return reply.send({
      items: rows.map((o) => ({
        id: o.id,
        photoMediaIds: media.filter((m) => m.orderId === o.id && m.position >= 0).map((m) => m.mediaId),
        status: o.status,
        moderationStatus: o.moderationStatus,
        normalizedTitle: o.normalizedTitle,
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

  app.get("/my/responses", { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, offset } = pagination(request.query);
    const rows = await db.query.responses.findMany({
      where: eq(schema.responses.executorId, request.userId),
      orderBy: (t, { desc: d }) => d(t.createdAt),
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

    return reply.send({
      items: rows.map((r) => {
        const order = orderById.get(r.orderId);
        return {
          id: r.id,
          orderId: r.orderId,
          orderTitle: order?.normalizedTitle ?? null,
          orderStatus: order?.status ?? null,
          orderAuthorId: order?.authorId ?? null,
          status: r.status,
          offeredPriceMinor: r.offeredPriceMinor,
          comment: r.comment,
          availabilityText: r.availabilityText,
          createdAt: r.createdAt,
          isContactUnlocked: unlockedOrderIds.has(r.orderId),
          assignmentStatus: assignmentStatusByOrderId.get(r.orderId) ?? null,
        };
      }),
      limit,
      offset,
    });
  });
}
