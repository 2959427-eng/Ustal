import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, lt } from "drizzle-orm";
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
/** response_status резерва: запрос с этим ключом ещё выполняется (HTTP-статуса 0 не бывает). */
const PENDING_STATUS = 0;
/** Сколько параллельный запрос ждёт ответа первого, прежде чем ответить 409 «ещё выполняется». */
const WAIT_MS = 20_000;
/** Резерв старше этого считается брошенным (процесс API упал посреди запроса). */
const STALE_MS = 2 * 60_000;

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
  if (key.length > 200) {
    await reply
      .code(400)
      .send({ error: { code: "idempotency_key_invalid", message: "Idempotency-Key длиннее 200 символов" } });
    return undefined;
  }

  const db = getDb();
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(request.body ?? {}))
    .digest("hex");

  const where = and(
    eq(schema.idempotencyKeys.userId, request.userId),
    eq(schema.idempotencyKeys.endpoint, endpoint),
    eq(schema.idempotencyKeys.key, key),
  );

  // Ключ резервируется в БД ДО выполнения handler'а (QA 2026-10-14, дефект №7). Раньше запись создавалась
  // после handler'а, и параллельные запросы с одним ключом все проходили проверку «ключа ещё нет» —
  // каждый создавал свой ввод. Теперь ровно один запрос вставляет резерв (unique index
  // idempotency_keys_unique решает гонку на уровне БД, в любом числе процессов API); остальные ждут его
  // ответа и отдают сохранённый. Резерв — строка с response_status = 0 (PENDING_STATUS): клиенту такой
  // статус никогда не отдаётся. created_at резерва — время захвата: зависший резерв (процесс API упал
  // посреди запроса) через STALE_MS может перехватить следующий запрос с тем же ключом.
  const deadline = Date.now() + WAIT_MS;
  let delay = 20;
  let claimed: { id: string } | undefined;
  for (;;) {
    [claimed] = await db
      .insert(schema.idempotencyKeys)
      .values({ userId: request.userId, endpoint, key, requestHash, responseStatus: PENDING_STATUS, responseBody: {} })
      .onConflictDoNothing()
      .returning({ id: schema.idempotencyKeys.id });
    if (claimed) break;

    const existing = await db.query.idempotencyKeys.findFirst({ where });
    if (!existing) continue; // резерв только что снят упавшим handler'ом — пробуем занять ключ сами
    if (existing.requestHash !== requestHash) {
      await reply.code(409).send({
        error: {
          code: "idempotency_key_conflict",
          message: "Этот Idempotency-Key уже использован с другим телом запроса",
        },
      });
      return undefined;
    }
    if (existing.responseStatus !== PENDING_STATUS) {
      await reply.code(existing.responseStatus).send(existing.responseBody as T);
      return undefined;
    }
    if (Date.now() - existing.createdAt.getTime() > STALE_MS) {
      // Перехват зависшего резерва — тоже атомарно: удаётся ровно одному из ожидающих.
      [claimed] = await db
        .update(schema.idempotencyKeys)
        .set({ createdAt: new Date() })
        .where(and(
          eq(schema.idempotencyKeys.id, existing.id),
          eq(schema.idempotencyKeys.responseStatus, PENDING_STATUS),
          lt(schema.idempotencyKeys.createdAt, new Date(Date.now() - STALE_MS)),
        ))
        .returning({ id: schema.idempotencyKeys.id });
      if (claimed) break;
      continue;
    }
    if (Date.now() > deadline) {
      await reply.code(409).send({
        error: {
          code: "idempotency_request_in_progress",
          message: "Запрос с этим Idempotency-Key ещё выполняется, повторите позже",
        },
      });
      return undefined;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 200);
  }

  let result: { status: number; body: T };
  try {
    result = await handler();
  } catch (error) {
    // Запрос не выполнен — снимаем резерв, чтобы повтор клиента с тем же ключом выполнился заново.
    await db.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.id, claimed.id)).catch(() => undefined);
    throw error;
  }
  const { status, body } = result;
  await db
    .update(schema.idempotencyKeys)
    .set({ responseStatus: status, responseBody: body })
    .where(eq(schema.idempotencyKeys.id, claimed.id));

  await reply.code(status).send(body);
  return body;
}
