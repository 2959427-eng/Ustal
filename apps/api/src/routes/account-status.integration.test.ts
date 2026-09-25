import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import authenticatePlugin from "../plugins/authenticate.js";
import authRoutes from "./auth.js";
import { signAccessToken } from "../lib/auth-tokens.js";

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-0123456789";

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
let userId: string, phone: string;

beforeAll(async () => {
  await app.register(authenticatePlugin);
  await app.register(authRoutes);
  app.get("/ping", { preHandler: app.authenticate }, async (request) => ({ userId: request.userId }));
  await app.ready();
  phone = `+7${Math.floor(1e9 + Math.random() * 9e9)}`;
  const [u] = await db.insert(schema.users).values({ phone, passwordHash: "local-test" }).returning();
  userId = u!.id;
  userIds.push(userId);
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await app.close();
  await getSql().end();
});

const ping = (token: string) => app.inject({ method: "GET", url: "/ping", headers: { authorization: `Bearer ${token}` } });

it("access token stops working right after the account is blocked, and works again after unblock", async () => {
  const token = signAccessToken(userId);
  expect((await ping(token)).statusCode).toBe(200);

  await db.update(schema.users).set({ status: "blocked" }).where(eq(schema.users.id, userId));
  const blocked = await ping(token);
  expect(blocked.statusCode).toBe(403);
  expect(blocked.json().error.code).toBe("account_blocked");

  await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, userId));
  expect((await ping(token)).statusCode).toBe(200);
});

it("token of a non-existing user is rejected", async () => {
  expect((await ping(signAccessToken(randomUUID()))).statusCode).toBe(401);
});

it("a blocked account keeps its phone: re-registration is refused", async () => {
  await db.update(schema.users).set({ status: "blocked" }).where(eq(schema.users.id, userId));
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Test", phone, password: "password123", cityId: randomUUID(), acceptedRules: true, acceptedPdn: true },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe("phone_taken");
});
