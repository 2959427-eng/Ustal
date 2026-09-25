import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import usersRoutes from "./users.js";

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let author: string, exec: string, stranger: string, orderId: string, avatarId: string;

const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(responsesRoutes);
  await app.register(usersRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST responder", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityIds.push(city!.id);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST r${i}`, cityId: city!.id, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [author, exec, stranger] = userIds as [string, string, string];
  const [m] = await db.insert(schema.media).values({
    ownerId: exec, kind: "photo", storageProvider: "local", mimeType: "image/jpeg", storageKey: "test/none.jpg", sizeBytes: 1,
  }).returning();
  avatarId = m!.id;
  await db.update(schema.userProfiles).set({ avatarMediaId: avatarId, about: "Учитель, 10 лет опыта" }).where(eq(schema.userProfiles.userId, exec));
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId: city!.id, sourceText: "TEST order", status: "published",
  }).returning();
  orderId = o!.id;
});

afterAll(async () => {
  await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
  await db.update(schema.userProfiles).set({ avatarMediaId: null }).where(inArray(schema.userProfiles.userId, userIds));
  await db.delete(schema.media).where(eq(schema.media.id, avatarId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

it("author sees responder's avatar in candidates and can open the responder's profile", async () => {
  const created = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec), payload: {} });
  expect(created.statusCode).toBe(201);

  const list = (await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(author) })).json().items;
  expect(list[0].executorAvatarMediaId).toBe(avatarId);

  const prof = await app.inject({ method: "GET", url: `/users/${exec}?orderId=${orderId}`, headers: as(author) });
  expect(prof.statusCode).toBe(200);
  expect(prof.json()).toMatchObject({ id: exec, avatarMediaId: avatarId, about: "Учитель, 10 лет опыта" });
  expect(JSON.stringify(prof.json())).not.toMatch(/phone/i);

  // посторонний не может смотреть профиль откликнувшегося
  expect((await app.inject({ method: "GET", url: `/users/${exec}?orderId=${orderId}`, headers: as(stranger) })).statusCode).toBe(404);

  // после отзыва отклика профиль недоступен
  const resp = await db.query.responses.findFirst({ where: eq(schema.responses.orderId, orderId) });
  await app.inject({ method: "DELETE", url: `/responses/${resp!.id}`, headers: as(exec) });
  expect((await app.inject({ method: "GET", url: `/users/${exec}?orderId=${orderId}`, headers: as(author) })).statusCode).toBe(404);
});
