import type { FastifyInstance } from "fastify";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { getRuntimeConfig } from "@ustal/config";
import { reportSchema } from "@ustal/validation";

/**
 * Жалобы (docs/api.md «Медиа и жалобы»). Модерация жалоб (просмотр очереди,
 * решения) — Фаза 8 admin-часть (routes/admin/*.ts). Здесь только приём:
 * любой пользователь может пожаловаться на заказ, другого пользователя или
 * отклик. Минимальная проверка существования цели — чтобы не копить жалобы
 * на несуществующие ID, но без раскрытия деталей найденной/ненайденной цели
 * сверх факта 404.
 */
export default async function reportsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/reports", { preHandler: app.authenticate }, async (request, reply) => {
    const body = reportSchema.parse(request.body);

    if (body.targetType === "user" && body.targetId === request.userId) {
      return reply.code(400).send({ error: { code: "invalid_target", message: "Нельзя пожаловаться на самого себя" } });
    }

    // Анти-abuse: без лимита жалобами на конкретную цель можно заваливать очередь
    // ручной модерации скриптом — отдельный per-user потолок в час.
    const config = getRuntimeConfig();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const exists = await targetExists(db, body.targetType, body.targetId);
    if (!exists) {
      return reply.code(404).send({ error: { code: "not_found", message: "Цель жалобы не найдена" } });
    }

    // Security-фикс (2026-09-22): тот же класс гонки, что и в POST /orders
    // (routes/orders.ts) — count (REPORTS_PER_HOUR) и insert раньше шли
    // отдельными запросами вне транзакции. pg_advisory_xact_lock по userId
    // сериализует конкурентные запросы одного и того же пользователя.
    let rateLimited = false;
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${request.userId}))`);

      const recentReports = await tx.query.reports.findMany({
        where: and(eq(schema.reports.reporterId, request.userId), gt(schema.reports.createdAt, hourAgo)),
      });
      if (recentReports.length >= config.rateLimits.reportsPerHour) {
        rateLimited = true;
        return undefined;
      }

      const [row] = await tx
        .insert(schema.reports)
        .values({
          reporterId: request.userId,
          targetType: body.targetType,
          targetId: body.targetId,
          reason: body.reason,
          comment: body.comment ?? null,
        })
        .returning();
      return row;
    });
    if (rateLimited) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: `Не более ${config.rateLimits.reportsPerHour} жалоб в час` },
      });
    }
    if (!created) throw new Error("Failed to create report");

    return reply.code(201).send({ id: created.id, status: created.status, createdAt: created.createdAt });
  });
}

async function targetExists(db: ReturnType<typeof getDb>, targetType: "order" | "user" | "response", targetId: string) {
  if (targetType === "order") {
    return !!(await db.query.orders.findFirst({ where: eq(schema.orders.id, targetId) }));
  }
  if (targetType === "user") {
    return !!(await db.query.users.findFirst({ where: eq(schema.users.id, targetId) }));
  }
  return !!(await db.query.responses.findFirst({ where: eq(schema.responses.id, targetId) }));
}
