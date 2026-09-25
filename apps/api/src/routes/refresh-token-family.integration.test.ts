import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import authenticatePlugin from "../plugins/authenticate.js";
import authRoutes from "./auth.js";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789";

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let cityId: string;

beforeAll(async () => {
  await app.register(authenticatePlugin);
  await app.register(authRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST refresh-family", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityId = city!.id;
  cityIds.push(cityId);
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const newPhone = () => `+7${Math.floor(1e9 + Math.random() * 9e9)}`;

type AuthPair = { accessToken: string; refreshToken: string };

async function registerUser() {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "TEST rf user", phone: newPhone(), password: "password123", cityId, acceptedRules: true, acceptedPdn: true },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as AuthPair & { userId: string };
  userIds.push(body.userId);
  return body;
}

const refresh = (refreshToken: string) => app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
const logout = (accessToken: string, refreshToken: string) =>
  app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${accessToken}` }, payload: { refreshToken } });

it("нормальная ротация: новый refresh наследует familyId родителя и остаётся рабочим", async () => {
  const { refreshToken: r1, userId } = await registerUser();
  const sessionsBefore = await db.query.userSessions.findMany({ where: eq(schema.userSessions.userId, userId) });
  expect(sessionsBefore.length).toBe(1);
  const familyId = sessionsBefore[0]!.familyId;

  const res1 = await refresh(r1);
  expect(res1.statusCode).toBe(200);
  const { refreshToken: r2 } = res1.json() as AuthPair;

  const sessionsAfter = await db.query.userSessions.findMany({ where: eq(schema.userSessions.userId, userId) });
  expect(sessionsAfter.length).toBe(2);
  expect(sessionsAfter.every((s) => s.familyId === familyId)).toBe(true);

  // Важно проверить ИМЕННО в этом порядке: повторное предъявление r1 — уже reuse (см. следующий
  // тест) и снесло бы всю family, включая r2, поэтому "новый токен работает" проверяем первым.
  expect((await refresh(r2)).statusCode).toBe(200);
});

it("reuse уже отозванного (ротацией) refresh отзывает всю family целиком, включая действовавший на тот момент токен", async () => {
  const { refreshToken: r1, userId } = await registerUser();
  const res1 = await refresh(r1); // r1 -> r2, r1 revoked
  const { refreshToken: r2 } = res1.json() as AuthPair;
  const res2 = await refresh(r2); // r2 -> r3, r2 revoked
  const { refreshToken: r3 } = res2.json() as AuthPair;

  const reuseRes = await refresh(r1); // r1 уже отозван — reuse
  expect(reuseRes.statusCode).toBe(401);
  expect(reuseRes.json().error.code).toBe("invalid_refresh_token");

  // вся family отозвана — r3, действовавший непосредственно перед reuse-попыткой, тоже недействителен
  expect((await refresh(r3)).statusCode).toBe(401);

  const sessions = await db.query.userSessions.findMany({ where: eq(schema.userSessions.userId, userId) });
  expect(sessions.length).toBe(3);
  expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
});

it("обычный logout по-прежнему работает: отзывает предъявленный refresh, ответ 204", async () => {
  const { refreshToken: r1, userId } = await registerUser();
  const res1 = await refresh(r1);
  const { accessToken: accessToken2, refreshToken: r2 } = res1.json() as AuthPair;

  const logoutRes = await logout(accessToken2, r2);
  expect(logoutRes.statusCode).toBe(204);

  const sessions = await db.query.userSessions.findMany({ where: eq(schema.userSessions.userId, userId) });
  expect(sessions.length).toBe(2);
  expect(sessions.every((s) => s.revokedAt !== null)).toBe(true); // r1 — ротацией, r2 — logout'ом

  // r2 уже отозван logout'ом; повторное предъявление — это ровно reuse-сценарий (ожидаемо 401)
  expect((await refresh(r2)).statusCode).toBe(401);
});

it("logout без Idempotency-специфики: некорректный/отсутствующий refreshToken в теле не ломает logout (204)", async () => {
  const { accessToken } = await registerUser();
  const res = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${accessToken}` }, payload: {} });
  expect(res.statusCode).toBe(204);
});
