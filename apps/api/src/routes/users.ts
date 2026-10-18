import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { getDb } from "@ustal/database";
import { loadReputation } from "../lib/reputation.js";

interface AuthorRow {
  [key: string]: unknown;
  id: string;
  name: string;
  avatar_media_id: string | null;
  about: string | null;
  city_id: string;
  member_since: string;
}

/**
 * Публичная карточка заказчика. Телефон и WhatsApp не отдаются никогда —
 * контакты раскрываются только через отдельный механизм после выбора.
 * Доступ — только в контексте заказа, который пользователь вправе видеть:
 * опубликованный/в переговорах/закрытый заказ либо заказ, на который у него есть отклик.
 */
export default async function usersRoutes(app: FastifyInstance) {
  const db = getDb();

  async function loadAuthor(requesterId: string, orderId: string, authorId?: string): Promise<AuthorRow | null> {
    const rows = await db.execute<AuthorRow>(sql`
      SELECT u.id, up.name, up.avatar_media_id, up.about, up.city_id, u.created_at AS member_since
      FROM orders o
      JOIN users u ON u.id = o.author_id
      JOIN user_profiles up ON up.user_id = u.id
      WHERE o.id = ${orderId}
        AND u.status = 'active'
        AND (${authorId ?? null}::uuid IS NULL OR o.author_id = ${authorId ?? null}::uuid)
        AND (
          o.status IN ('published','negotiating','closed')
          OR EXISTS (SELECT 1 FROM responses r WHERE r.order_id = o.id AND r.executor_id = ${requesterId})
        )
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = o.author_id AND b.blocked_id = ${requesterId})
             OR (b.blocker_id = ${requesterId} AND b.blocked_id = o.author_id)
        )
      LIMIT 1
    `);
    return [...rows][0] ?? null;
  }

  // Заказчик смотрит профиль исполнителя, откликнувшегося на его заказ (не отозванный отклик).
  async function loadResponder(requesterId: string, orderId: string, executorId: string): Promise<AuthorRow | null> {
    const rows = await db.execute<AuthorRow>(sql`
      SELECT u.id, up.name, up.avatar_media_id, up.about, up.city_id, u.created_at AS member_since
      FROM orders o
      JOIN responses r ON r.order_id = o.id AND r.executor_id = ${executorId}::uuid AND r.status <> 'withdrawn'
      JOIN users u ON u.id = r.executor_id
      JOIN user_profiles up ON up.user_id = u.id
      WHERE o.id = ${orderId}
        AND o.author_id = ${requesterId}
        AND u.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = o.author_id AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = o.author_id)
        )
      LIMIT 1
    `);
    return [...rows][0] ?? null;
  }

  const notFound = { error: { code: "not_found", message: "Профиль не найден" } };
  const toDto = async (r: AuthorRow) => ({
    id: r.id,
    name: r.name,
    avatarMediaId: r.avatar_media_id,
    about: r.about,
    cityId: r.city_id,
    memberSince: r.member_since,
    // Две отдельные репутации; без количества оценок. Рейтинг только для показа.
    reputation: await loadReputation(db, r.id),
  });

  // Своя репутация (экран «Мой профиль»).
  app.get("/me/reputation", { preHandler: app.authenticate }, async (request, reply) => {
    return reply.send(await loadReputation(db, request.userId));
  });

  // Автор заказа (для аватарки на экране заказа).
  app.get("/orders/:id/author", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await loadAuthor(request.userId, id);
    if (!row) return reply.code(404).send(notFound);
    return reply.send(await toDto(row));
  });

  // Профиль заказчика; ?orderId — заказ, из которого открыт профиль.
  app.get("/users/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orderId } = request.query as { orderId?: string };
    if (!orderId) return reply.code(404).send(notFound);
    const row = (await loadAuthor(request.userId, orderId, id)) ?? (await loadResponder(request.userId, orderId, id));
    if (!row) return reply.code(404).send(notFound);
    return reply.send(await toDto(row));
  });
}
