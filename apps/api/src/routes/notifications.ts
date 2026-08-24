import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * In-app уведомления (docs/api.md «Уведомления и устройства»). Список не
 * зависит от того, дошёл ли push (см. apps/api/src/lib/notify.ts) — это
 * отдельный источник истины внутри приложения.
 */
export default async function notificationsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/notifications", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(query.offset) || 0);

    const rows = await db.query.notifications.findMany({
      where: eq(schema.notifications.userId, request.userId),
      orderBy: (t, { desc }) => desc(t.createdAt),
      limit,
      offset,
    });

    return reply.send({
      items: rows.map((n) => ({ id: n.id, type: n.type, payload: n.payload, readAt: n.readAt, createdAt: n.createdAt })),
      limit,
      offset,
    });
  });

  app.post("/notifications/:id/read", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await db.query.notifications.findFirst({ where: eq(schema.notifications.id, id) });
    if (!existing || existing.userId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Уведомление не найдено" } });
    }
    if (!existing.readAt) {
      await db.update(schema.notifications).set({ readAt: new Date() }).where(eq(schema.notifications.id, id));
    }
    return reply.code(204).send();
  });
}
