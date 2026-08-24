import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { blockSchema } from "@ustal/validation";

/**
 * Блокировки (docs/api.md «Медиа и жалобы», docs/matching.md §13.1 — matching
 * исключает заблокированные/взаимно заблокированные пары). Симметрично не
 * означает одну строку на пару: `blocks` хранит направление (`blocker_id`
 * заблокировал `blocked_id`), matching-run.ts уже учитывает обе стороны
 * (`WHERE blocker_id = author OR blocked_id = author`). `GET`/`DELETE` не
 * перечислены в api.md явно, но нужны для управления списком блокировок —
 * минимальное симметричное расширение по тому же паттерну, что и
 * `responses`/`contact_unlocks`.
 */
export default async function blocksRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/blocks", { preHandler: app.authenticate }, async (request, reply) => {
    const body = blockSchema.parse(request.body);
    if (body.blockedId === request.userId) {
      return reply.code(400).send({ error: { code: "invalid_target", message: "Нельзя заблокировать самого себя" } });
    }

    const target = await db.query.users.findFirst({ where: eq(schema.users.id, body.blockedId) });
    if (!target) {
      return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    }

    let created: typeof schema.blocks.$inferSelect | undefined;
    try {
      [created] = await db
        .insert(schema.blocks)
        .values({ blockerId: request.userId, blockedId: body.blockedId })
        .returning();
    } catch (err) {
      const pgCode = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
      if (pgCode === "23505") {
        const existing = await db.query.blocks.findFirst({
          where: and(eq(schema.blocks.blockerId, request.userId), eq(schema.blocks.blockedId, body.blockedId)),
        });
        return reply.code(200).send({ id: existing?.id, blockedId: body.blockedId, createdAt: existing?.createdAt });
      }
      throw err;
    }
    if (!created) throw new Error("Failed to create block");

    return reply.code(201).send({ id: created.id, blockedId: created.blockedId, createdAt: created.createdAt });
  });

  app.get("/blocks", { preHandler: app.authenticate }, async (request, reply) => {
    const rows = await db.query.blocks.findMany({ where: eq(schema.blocks.blockerId, request.userId) });
    return reply.send({ items: rows.map((b) => ({ id: b.id, blockedId: b.blockedId, createdAt: b.createdAt })) });
  });

  app.delete("/blocks/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await db.query.blocks.findFirst({ where: eq(schema.blocks.id, id) });
    if (!existing || existing.blockerId !== request.userId) {
      return reply.code(404).send({ error: { code: "not_found", message: "Блокировка не найдена" } });
    }
    await db.delete(schema.blocks).where(eq(schema.blocks.id, id));
    return reply.code(204).send();
  });
}
