import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { deleteAccountSchema } from "@ustal/validation";
import { hashPassword, verifyPassword } from "../lib/password.js";

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
    });
  });

  /**
   * Удаление аккаунта — Apple App Review Guidelines 5.1.1(v) и Google Play
   * account deletion policy требуют, чтобы приложение с созданием аккаунта
   * давало его удалить внутри самого приложения (см. claude/store-
   * compliance-audit.md в Cowork Project). Требуем пароль ещё раз — действие
   * необратимо для пользователя, это не просто выход из сессии.
   *
   * Это МЯГКОЕ удаление (status='deleted' + обезличивание), не физический
   * DELETE FROM users: orders.authorId, responses.executorId,
   * reviews.fromUserId/toUserId, matchingCandidates.userId и т.д. ссылаются
   * на users.id БЕЗ onDelete: "cascade" (см. packages/database/src/schema.ts)
   * — жёсткое удаление уронило бы историю заказов/откликов/отзывов других,
   * ни в чём не виноватых пользователей. Вместо этого: аккаунт помечается
   * status='deleted' (учтено в схеме — комментарий у users.status уже
   * перечисляет active|blocked|deleted), логин на такой номер и пароль
   * больше невозможен (login/refresh фильтруют по status='active'),
   * телефон обезличивается и освобождается для новой регистрации,
   * персональные поля профиля (имя, WhatsApp, аватар) стираются, все
   * refresh-сессии отзываются, push-устройства деактивируются. История
   * заказов/откликов/отзывов, где фигурировал этот пользователь, остаётся —
   * но уже без личных данных удалённого аккаунта, только обезличенное имя.
   */
  app.delete("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const body = deleteAccountSchema.parse(request.body);

    const user = await db.query.users.findFirst({ where: eq(schema.users.id, request.userId) });
    if (!user) {
      return reply.code(404).send({ error: { code: "not_found", message: "Пользователь не найден" } });
    }

    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      return reply.code(401).send({ error: { code: "invalid_credentials", message: "Неверный пароль" } });
    }

    const now = new Date();
    // varchar(20): "del_" (4) + первые 16 символов uuid = 20 — умещается
    // ровно, освобождает исходный номер для будущей активной регистрации
    // (users_phone_active_unique — частичный индекс только по status='active').
    const anonymizedPhone = `del_${user.id.slice(0, 16)}`;
    // Пароль тоже стирается (не только становится недостижимым через
    // status!='active' в /auth/login) — дополнительный слой, не полагаемся
    // только на фильтр по статусу.
    const unusablePasswordHash = await hashPassword(randomUUID());

    await db
      .update(schema.users)
      .set({ status: "deleted", phone: anonymizedPhone, passwordHash: unusablePasswordHash })
      .where(eq(schema.users.id, user.id));

    await db
      .update(schema.userProfiles)
      .set({ name: "Удалённый пользователь", whatsappPhone: null, avatarMediaId: null, updatedAt: now })
      .where(eq(schema.userProfiles.userId, user.id));

    await db
      .update(schema.userSessions)
      .set({ revokedAt: now })
      .where(and(eq(schema.userSessions.userId, user.id), isNull(schema.userSessions.revokedAt)));

    await db
      .update(schema.deviceInstallations)
      .set({ isActive: false })
      .where(eq(schema.deviceInstallations.userId, user.id));

    await db.insert(schema.auditLogs).values({
      actorType: "user",
      actorId: user.id,
      action: "account_deleted",
      targetType: "user",
      targetId: user.id,
      metadata: {},
    });

    return reply.code(204).send();
  });
}
