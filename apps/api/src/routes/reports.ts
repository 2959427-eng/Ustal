import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
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

    const exists = await targetExists(db, body.targetType, body.targetId);
    if (!exists) {
      return reply.code(404).send({ error: { code: "not_found", message: "Цель жалобы не найдена" } });
    }

    const [created] = await db
      .insert(schema.reports)
      .values({
        reporterId: request.userId,
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        comment: body.comment ?? null,
      })
      .returning();
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
