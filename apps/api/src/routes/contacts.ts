import { authorTitle } from "../lib/order-text.js";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { contactUnlockSchema } from "@ustal/validation";
import { notifyUser } from "../lib/notify.js";
import { areBlocked } from "../lib/blocks.js";
import { canUnlockContactsForOrder, isContactAccessOpen } from "../lib/contact-access.js";

/**
 * «Обсудить заказ» → contact_unlock (docs/api.md, docs/matching.md,
 * architecture.md §5 п.8: раскрытие контакта — явное действие автора заказа,
 * без продуктового лимита («не устанавливай лимит» — ТЗ), но с технической
 * anti-abuse защитой (`CONTACT_UNLOCKS_PER_HOUR`), невидимой пользователю
 * как ограничение продукта. Телефон/WhatsApp отдаются только сторонам уже
 * существующего unlock'а (`GET /orders/{id}/contacts/{userId}`), никогда по
 * голому ID пользователя.
 */
export default async function contactsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/orders/:id/contact-unlocks", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId } = request.params as { id: string };
    const body = contactUnlockSchema.parse(request.body);

    const order = await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) });
    if (!order || order.authorId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Заказ не найден" } });
    }

    const response = await db.query.responses.findFirst({ where: eq(schema.responses.id, body.responseId) });
    if (!response || response.orderId !== orderId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отклик не найден" } });
    }
    if (!canUnlockContactsForOrder(order.status)) {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Контакт нельзя раскрыть: заказ в статусе "${order.status}"` },
      });
    }

    if (await areBlocked(db, request.userId, response.executorId)) {
      return reply.code(404).send({ error: { code: "not_found", message: "Отклик не найден" } });
    }

    const executor = await db.query.users.findFirst({ where: eq(schema.users.id, response.executorId), columns: { status: true } });
    if (executor?.status !== "active") {
      return reply.code(409).send({ error: { code: "invalid_status", message: "Исполнитель недоступен — контакт нельзя раскрыть" } });
    }

    const existing = await db.query.contactUnlocks.findFirst({
      where: and(eq(schema.contactUnlocks.orderId, orderId), eq(schema.contactUnlocks.executorId, response.executorId)),
    });
    if (existing) {
      // Идемпотентно: контакт уже раскрыт для этой пары — повторный вызов не
      // тратит rate limit и не плодит уведомления, просто отдаёт то же самое.
      return reply.code(200).send({ id: existing.id, orderId, executorId: existing.executorId, unlockedAt: existing.unlockedAt });
    }

    if (response.status !== "active") {
      return reply.code(409).send({
        error: { code: "invalid_status", message: `Отклик в статусе "${response.status}" — контакт нельзя раскрыть` },
      });
    }

    const config = getRuntimeConfig();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Раньше count и insert шли отдельными запросами вне транзакции — под
    // параллельными запросами одного заказчика оба могли пройти проверку лимита
    // до того, как хоть один insert зафиксируется, и лимит превышался на гонке.
    // pg_advisory_xact_lock по customerId сериализует конкурентные запросы одного
    // и того же заказчика на время транзакции (снимается сам при commit/rollback),
    // не блокируя запросы разных заказчиков друг с другом.
    let rateLimited = false;
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${request.userId}))`);

      const recentUnlocks = await tx
        .select({ id: schema.contactUnlocks.id })
        .from(schema.contactUnlocks)
        .where(and(eq(schema.contactUnlocks.customerId, request.userId), gt(schema.contactUnlocks.unlockedAt, hourAgo)));
      if (recentUnlocks.length >= config.rateLimits.contactUnlocksPerHour) {
        rateLimited = true;
        return undefined;
      }

      const [row] = await tx
        .insert(schema.contactUnlocks)
        .values({ orderId, customerId: request.userId, executorId: response.executorId, responseId: response.id })
        .returning();
      return row;
    });
    if (rateLimited) {
      return reply.code(429).send({
        error: {
          code: "rate_limited",
          message: `Не более ${config.rateLimits.contactUnlocksPerHour} раскрытий контактов в час`,
        },
      });
    }
    if (!created) throw new Error("Failed to create contact_unlock");

    await notifyUser(response.executorId, "contact_unlocked", {
      orderId,
      responseId: response.id,
      title: "Заказчик открыл ваш контакт",
      body: (authorTitle(order.sourceText) ?? order.normalizedTitle) ? `Можно обсудить «${(authorTitle(order.sourceText) ?? order.normalizedTitle)}»` : "Заказчик готов обсудить заказ",
    });

    return reply.code(201).send({ id: created.id, orderId, executorId: created.executorId, unlockedAt: created.unlockedAt });
  });

  app.get("/orders/:id/contacts/:userId", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: orderId, userId: otherUserId } = request.params as { id: string; userId: string };

    const unlock = await db.query.contactUnlocks.findFirst({
      where: and(
        eq(schema.contactUnlocks.orderId, orderId),
        or(
          and(eq(schema.contactUnlocks.customerId, request.userId), eq(schema.contactUnlocks.executorId, otherUserId)),
          and(eq(schema.contactUnlocks.executorId, request.userId), eq(schema.contactUnlocks.customerId, otherUserId)),
        ),
      ),
    });
    if (!unlock || (await areBlocked(db, request.userId, otherUserId))) {
      return reply.code(404).send({ error: { code: "not_found", message: "Контакт не раскрыт для этой пары" } });
    }

    // Запись раскрытия — только история. Доступ есть, пока отношения живые (lib/contact-access.ts).
    const [order, assignment, unlockedResponse] = await Promise.all([
      db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }),
      db.query.orderAssignments.findFirst({
        where: and(eq(schema.orderAssignments.orderId, orderId), eq(schema.orderAssignments.executorId, unlock.executorId)),
      }),
      db.query.responses.findFirst({ where: eq(schema.responses.id, unlock.responseId) }),
    ]);
    if (!isContactAccessOpen({ orderStatus: order?.status, assignmentStatus: assignment?.status, responseStatus: unlockedResponse?.status })) {
      return reply.code(404).send({ error: { code: "not_found", message: "Контакт не раскрыт для этой пары" } });
    }

    const [user, profile] = await Promise.all([
      db.query.users.findFirst({ where: eq(schema.users.id, otherUserId) }),
      db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, otherUserId) }),
    ]);
    if (!user || !profile || user.status !== "active") {
      return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    }

    return reply.send({
      userId: otherUserId,
      name: profile.name,
      phone: user.phone,
      whatsappPhone: profile.whatsappPhone, // null → клиент не показывает кнопку WhatsApp
    });
  });
}
