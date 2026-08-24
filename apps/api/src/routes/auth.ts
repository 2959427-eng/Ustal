import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
import { loginSchema, refreshSchema, registerSchema } from "@ustal/validation";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "../lib/auth-tokens.js";

/**
 * Auth: Argon2id, access + rotating refresh tokens, revoke, rate limiting
 * (глобальный per-route rate limit подключается в app.ts через @fastify/rate-limit;
 * защита от перебора логина — количество попыток не увеличивает счётчик успеха,
 * ответ на неверный phone/password всегда одинаковый, чтобы не палить, какой
 * из двух неверен).
 */
export default async function authRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    const existing = await db.query.users.findFirst({
      where: and(eq(schema.users.phone, body.phone), eq(schema.users.status, "active")),
    });
    if (existing) {
      return reply.code(409).send({ error: { code: "phone_taken", message: "Этот номер уже используется" } });
    }

    const passwordHash = await hashPassword(body.password);
    const now = new Date();

    const [user] = await db
      .insert(schema.users)
      .values({ phone: body.phone, passwordHash, status: "active" })
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
      deviceInfo: request.headers["user-agent"] ?? null,
      expiresAt: refresh.expiresAt,
    });

    return reply.code(201).send({ accessToken, refreshToken: refresh.token, userId: user.id });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await db.query.users.findFirst({
      where: and(eq(schema.users.phone, body.phone), eq(schema.users.status, "active")),
    });
    const genericError = () =>
      reply.code(401).send({ error: { code: "invalid_credentials", message: "Неверный телефон или пароль" } });

    if (!user) return genericError();
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) return genericError();

    const accessToken = signAccessToken(user.id);
    const refresh = generateRefreshToken();
    await db.insert(schema.userSessions).values({
      userId: user.id,
      refreshTokenHash: refresh.hash,
      deviceInfo: request.headers["user-agent"] ?? null,
      expiresAt: refresh.expiresAt,
    });

    return reply.send({ accessToken, refreshToken: refresh.token, userId: user.id });
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const hash = hashRefreshToken(body.refreshToken);

    const session = await db.query.userSessions.findFirst({
      where: eq(schema.userSessions.refreshTokenHash, hash),
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return reply.code(401).send({ error: { code: "invalid_refresh_token", message: "Сессия недействительна" } });
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
      return reply.code(401).send({ error: { code: "invalid_refresh_token", message: "Сессия недействительна" } });
    }

    // rotating refresh: старый токен отзывается, выдаётся новый
    await db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.userSessions.id, session.id));

    const accessToken = signAccessToken(session.userId);
    const refresh = generateRefreshToken();
    await db.insert(schema.userSessions).values({
      userId: session.userId,
      refreshTokenHash: refresh.hash,
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
