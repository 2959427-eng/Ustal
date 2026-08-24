import type { FastifyInstance } from "fastify";
import { and, eq, gt, or } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { contactUnlockSchema } from "@ustal/validation";
import { notifyUser } from "../lib/notify.js";

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
    const recentUnlocks = await db.query.contactUnlocks.findMany({
      where: and(eq(schema.contactUnlocks.customerId, request.userId), gt(schema.contactUnlocks.unlockedAt, hourAgo)),
    });
    if (recentUnlocks.length >= config.rateLimits.contactUnlocksPerHour) {
      return reply.code(429).send({
        error: {
          code: "rate_limited",
          message: `Не более ${config.rateLimits.contactUnlocksPerHour} раскрытий контактов в час`,
        },
      });
    }

    const [created] = await db
      .insert(schema.contactUnlocks)
      .values({ orderId, customerId: request.userId, executorId: response.executorId, responseId: response.id })
      .returning();
    if (!created) throw new Error("Failed to create contact_unlock");

    await notifyUser(response.executorId, "contact_unlocked", {
      orderId,
      responseId: response.id,
      title: "Заказчик открыл ваш контакт",
      body: order.normalizedTitle ? `Можно обсудить «${order.normalizedTitle}»` : "Заказчик готов обсудить заказ",
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
    if (!unlock) {
      return reply.code(404).send({ error: { code: "not_found", message: "Контакт не раскрыт для этой пары" } });
    }

    const [user, profile] = await Promise.all([
      db.query.users.findFirst({ where: eq(schema.users.id, otherUserId) }),
      db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, otherUserId) }),
    ]);
    if (!user || !profile) {
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
