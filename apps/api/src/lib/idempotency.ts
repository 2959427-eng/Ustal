import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";

/**
 * Общая идемпотентность для endpoint'ов, инициирующих AI-вызов (docs/api.md:
 * POST /orders, POST /profile/inputs). Повторный запрос с тем же
 * Idempotency-Key и тем же телом возвращает сохранённый ответ без повторного
 * выполнения handler'а (и без повторной постановки job в очередь); тот же
 * ключ с другим телом — 409.
 *
 * Возвращает `undefined`, если уже отправила ответ сама (ошибка заголовка,
 * конфликт, или replay из кеша) — в этом случае вызывающий код должен сразу
 * вернуться, ничего больше не выполняя.
 */
export async function withIdempotency<T extends Record<string, unknown>>(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: string,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<T | undefined> {
  const key = request.headers["idempotency-key"];
  if (!key || typeof key !== "string") {
    await reply
      .code(400)
      .send({ error: { code: "idempotency_key_required", message: "Заголовок Idempotency-Key обязателен" } });
    return undefined;
  }

  const db = getDb();
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(request.body ?? {}))
    .digest("hex");

  const existing = await db.query.idempotencyKeys.findFirst({
    where: and(
      eq(schema.idempotencyKeys.userId, request.userId),
      eq(schema.idempotencyKeys.endpoint, endpoint),
      eq(schema.idempotencyKeys.key, key),
    ),
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      await reply.code(409).send({
        error: {
          code: "idempotency_key_conflict",
          message: "Этот Idempotency-Key уже использован с другим телом запроса",
        },
      });
      return undefined;
    }
    await reply.code(existing.responseStatus).send(existing.responseBody as T);
    return undefined;
  }

  const { status, body } = await handler();

  // Гонка параллельных запросов с одинаковым ключом — редкий край случай для
  // MVP: unique index не даст создать вторую запись, ответ каждого запроса
  // уже отправлен независимо, onConflictDoNothing просто не дублирует лог.
  await db
    .insert(schema.idempotencyKeys)
    .values({ userId: request.userId, endpoint, key, requestHash, responseStatus: status, responseBody: body })
    .onConflictDoNothing();

  await reply.code(status).send(body);
  return body;
}
