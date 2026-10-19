import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { drainMediaCleanup, getDb, schema } from "@ustal/database";
import { getMediaStorage } from "@ustal/storage";
import { deleteAccountSchema } from "@ustal/validation";
import { verifyPassword } from "../lib/password.js";
import { isLoginThrottled, recordLoginFailure, resetLoginFailures } from "../lib/login-throttle.js";
import { deleteAccount } from "../lib/account-deletion.js";
import { notifyUser } from "../lib/notify.js";

export default async function meRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, request.userId),
    });
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user || !profile) {
      return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    }
    return reply.send({
      id: user.id,
      phone: user.phone,
      phoneVerified: !!user.phoneVerifiedAt,
      name: profile.name,
      cityId: profile.cityId,
      whatsappPhone: profile.whatsappPhone,
      avatarMediaId: profile.avatarMediaId,
      about: profile.about,
    });
  });

  /**
   * Удаление аккаунта (Apple 5.1.1(v), Google Play). Пароль ещё раз; неверный пароль — 403 invalid_password
   * (не 401: клиент на 401 обновляет токен), попытки ограничены тем же счётчиком, что и вход. Работа в процессе
   * блокирует удаление (409 active_work). Повтор после успеха: токен больше не действует (401). Что удаляется и
   * что обезличивается — lib/account-deletion.ts.
   */
  app.delete("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const body = deleteAccountSchema.parse(request.body ?? {});
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user) return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or expired token" } });
    if (isLoginThrottled(user.phone)) {
      return reply.code(429).send({ error: { code: "too_many_attempts", message: "Слишком много попыток. Попробуйте позже." } });
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      recordLoginFailure(user.phone);
      return reply.code(403).send({ error: { code: "invalid_password", message: "Неверный пароль" } });
    }
    resetLoginFailures(user.phone);

    // Взаимная блокировка с параллельной записью (PG прерывает одну из транзакций) — удаление повторяется.
    let result: Awaited<ReturnType<typeof deleteAccount>>;
    const storage = getMediaStorage();
    for (let attempt = 0; ; attempt++) {
      try { result = await deleteAccount(db, user.id, storage); break; }
      catch (error) {
        const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
        if (code !== "40P01" || attempt >= 2) throw error;
      }
    }
    if (result.status === "gone") return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or expired token" } });
    if (result.status === "active_work") {
      return reply.code(409).send({ error: { code: "active_work",
        message: "Есть заказы в работе. Завершите их (или отметьте результат), затем удалите аккаунт." } });
    }
    // После commit: уведомления второй стороне и удаление файлов. Сбой здесь не отменяет удаление и не даёт 500.
    for (const n of result.notices)
      await notifyUser(n.userId, n.type, n.payload).catch(() => request.log.warn({ type: n.type }, "account deletion notice failed"));
    try {
      const cleanup = await drainMediaCleanup(db, storage, { ids: result.cleanupIds });
      if (cleanup.failed) request.log.warn({ failed: cleanup.failed }, "account deletion: media cleanup retained for retry");
    } catch { request.log.warn("account deletion: media cleanup retained for retry"); }
    return reply.code(204).send();
  });
}
