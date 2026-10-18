import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loadEnv } from "@ustal/config";
import { loginSchema, refreshSchema, registerSchema } from "@ustal/validation";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { isLoginThrottled, recordLoginFailure, resetLoginFailures } from "../lib/login-throttle.js";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "../lib/auth-tokens.js";
import { verifyPhoneVerificationToken } from "../lib/phone-verification-token.js";

/**
 * Auth: Argon2id, access + rotating refresh tokens, revoke, rate limiting
 * (глобальный per-route rate limit подключается в app.ts через @fastify/rate-limit;
 * защита от перебора логина — количество попыток не увеличивает счётчик успеха,
 * ответ на неверный phone/password всегда одинаковый, чтобы не палить, какой
 * из двух неверен).
 */
export default async function authRoutes(app: FastifyInstance) {
  const db = getDb();

  // Глобальный rate-limit (app.ts, 100/мин на IP) применяется одинаково ко
  // всем ручкам — для /auth/login и /auth/register этого мало (подбор
  // пароля/спам регистраций одним IP), поэтому здесь дополнительно затянуто
  // per-route через тот же @fastify/rate-limit (не отдельный пакет — просто
  // route-level override, ничего не ломает для остальных ручек).
  app.post("/auth/register", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // Номер занят и заблокированным аккаунтом: иначе бан обходится повторной регистрацией.
    const existing = await db.query.users.findFirst({
      where: and(eq(schema.users.phone, body.phone), inArray(schema.users.status, ["active", "blocked"])),
    });
    if (existing) {
      return reply.code(409).send({ error: { code: "phone_taken", message: "Этот номер уже используется" } });
    }

    // Пока PHONE_VERIFICATION_MODE=disabled (по умолчанию), поведение НЕ меняется: телефон
    // сохраняется неподтверждённым и это ничего не блокирует (raздел про MVP). Флаг
    // required_for_new требует токен от POST /auth/otp/verify для НОВЫХ регистраций —
    // уже существующие аккаунты это не затрагивает (см. routes/phone-verification.ts).
    const phoneVerificationMode = loadEnv().PHONE_VERIFICATION_MODE;
    if (phoneVerificationMode === "required_for_new") {
      if (!body.phoneVerificationToken) {
        return reply.code(400).send({
          error: { code: "phone_verification_required", message: "Нужно подтвердить телефон кодом из SMS" },
        });
      }
      const verifiedPhone = verifyPhoneVerificationToken(body.phoneVerificationToken);
      if (verifiedPhone !== body.phone) {
        return reply.code(400).send({
          error: { code: "phone_verification_invalid", message: "Код подтверждения телефона недействителен или относится к другому номеру" },
        });
      }
    }

    const passwordHash = await hashPassword(body.password);
    const now = new Date();

    const [user] = await db
      .insert(schema.users)
      .values({
        phone: body.phone,
        passwordHash,
        status: "active",
        phoneVerifiedAt: phoneVerificationMode === "required_for_new" ? now : null,
        verificationLevel: phoneVerificationMode === "required_for_new" ? "phone" : "none",
      })
      .returning();
    if (!user) throw new Error("Failed to create user");

    await db.insert(schema.userProfiles).values({
      userId: user.id,
      name: body.name,
      cityId: body.cityId,
      acceptedRulesAt: now,
      acceptedPdnAt: now,
    });

    const accessToken = signAccessToken(user.id);
    const refresh = generateRefreshToken();
    await db.insert(schema.userSessions).values({
      userId: user.id,
      refreshTokenHash: refresh.hash,
      familyId: randomUUID(), // новая цепочка ротации — первая сессия аккаунта на этом устройстве
      deviceInfo: request.headers["user-agent"] ?? null,
      expiresAt: refresh.expiresAt,
    });

    return reply.code(201).send({ accessToken, refreshToken: refresh.token, userId: user.id });
  });

  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);

    if (isLoginThrottled(body.phone)) {
      return reply.code(429).send({ error: { code: "too_many_attempts", message: "Слишком много попыток входа. Попробуйте позже." } });
    }

    const user = await db.query.users.findFirst({
      where: and(eq(schema.users.phone, body.phone), eq(schema.users.status, "active")),
    });
    const genericError = () =>
      reply.code(401).send({ error: { code: "invalid_credentials", message: "Неверный телефон или пароль" } });

    if (!user) {
      recordLoginFailure(body.phone);
      return genericError();
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      recordLoginFailure(body.phone);
      return genericError();
    }
    resetLoginFailures(body.phone);

    const accessToken = signAccessToken(user.id);
    const refresh = generateRefreshToken();
    await db.insert(schema.userSessions).values({
      userId: user.id,
      refreshTokenHash: refresh.hash,
      familyId: randomUUID(), // новая цепочка ротации — новый логин, не связан с прошлыми сессиями
      deviceInfo: request.headers["user-agent"] ?? null,
      expiresAt: refresh.expiresAt,
    });

    return reply.send({
      accessToken,
      refreshToken: refresh.token,
      userId: user.id,
      // Не блокирует вход — только сигнал клиенту показать (необязательный) экран
      // подтверждения номера. false и когда флаг выключен, и когда телефон уже подтверждён.
      phoneVerificationSuggested: loadEnv().PHONE_VERIFICATION_MODE !== "disabled" && !user.phoneVerifiedAt,
    });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const hash = hashRefreshToken(body.refreshToken);
    const invalidTokenResponse = () =>
      reply.code(401).send({ error: { code: "invalid_refresh_token", message: "Сессия недействительна" } });

    const session = await db.query.userSessions.findFirst({
      where: eq(schema.userSessions.refreshTokenHash, hash),
    });
    if (!session) {
      return invalidTokenResponse();
    }

    // Reuse detection: этот refresh уже был отозван (обычной ротацией или logout'ом), но
    // предъявлен снова — легитимный клиент так не делает (использует только последний выданный
    // токен), значит кто-то получил уже неактуальный токен из цепочки. Отзываем всю family
    // (все ещё живые сессии этой цепочки ротации) одним запросом, а не только эту сессию —
    // иначе токен, украденный и использованный раньше владельца, оставлял бы атакующему рабочую
    // пару access/refresh даже после того, как владелец обнаружит проблему по своему логауту.
    if (session.revokedAt) {
      await db
        .update(schema.userSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.userSessions.familyId, session.familyId), isNull(schema.userSessions.revokedAt)));
      request.log.warn(
        { event: "refresh_token_reuse_detected", userId: session.userId, familyId: session.familyId, sessionId: session.id },
        "refresh token reuse detected — revoked session family",
      );
      return invalidTokenResponse();
    }

    if (session.expiresAt < new Date()) {
      return invalidTokenResponse();
    }

    // Найдено в Фазе 8 (см. architecture.md §5): до блокировки пользователя
    // /auth/refresh не проверял users.status вообще — заблокированный
    // администратором аккаунт мог продолжать получать новые access token'ы
    // через уже выданный refresh, пока сам refresh не истечёт (до
    // REFRESH_TOKEN_TTL_DAYS, а не до ближайшего логина). Access token
    // (JWT, ACCESS_TOKEN_TTL_MINUTES) отзыву не подлежит в принципе — это
    // общее для MVP ограничение (нет denylist'а), refresh — единственная
    // реальная точка принудительного разрыва сессии.
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, session.userId) });
    if (!user || user.status !== "active") {
      await db.update(schema.userSessions).set({ revokedAt: new Date() }).where(eq(schema.userSessions.id, session.id));
      return invalidTokenResponse();
    }

    // rotating refresh: старый токен отзывается, выдаётся новый в той же family
    await db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.userSessions.id, session.id));

    const accessToken = signAccessToken(session.userId);
    const refresh = generateRefreshToken();
    await db.insert(schema.userSessions).values({
      userId: session.userId,
      refreshTokenHash: refresh.hash,
      familyId: session.familyId,
      deviceInfo: request.headers["user-agent"] ?? null,
      expiresAt: refresh.expiresAt,
    });

    return reply.send({ accessToken, refreshToken: refresh.token });
  });

  app.post("/auth/logout", { preHandler: app.authenticate }, async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);
    if (body.success) {
      const hash = hashRefreshToken(body.data.refreshToken);
      await db
        .update(schema.userSessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.userSessions.refreshTokenHash, hash));
    }
    return reply.code(204).send();
  });
}
