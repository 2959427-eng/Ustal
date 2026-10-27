import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import ordersRoutes from "./orders.js";

// 2026-10-27: фото пользователя A (mediaId) не может попасть в заказ пользователя B — проверка на сервере, не в клиенте.
vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));
vi.mock("@ustal/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ustal/queue")>();
  return { ...actual, getBoss: vi.fn(async () => ({ send: vi.fn(async () => "test-job-id") })) };
});

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
let cityId: string, userA: string, userB: string, photoA: string, photoB: string;
const as = (u: string) => ({ "x-test-user": u, "idempotency-key": randomUUID() });
const create = (user: string, mediaIds: string[]) =>
  app.inject({ method: "POST", url: "/orders", headers: as(user), payload: { inputType: "text", text: "TEST покрасить забор", mediaIds } });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = request.headers["x-test-user"] as string; });
  await app.register(ordersRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({ name: "TEST media", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = city!.id;
  for (let i = 0; i < 2; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({ userId: u!.id, name: `TEST m${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() });
  }
  [userA, userB] = userIds as [string, string];
  const media = async (ownerId: string) => (await db.insert(schema.media).values({ ownerId, kind: "photo", storageProvider: "local", storageKey: `test/${randomUUID()}`, mimeType: "image/jpeg" }).returning())[0]!.id;
  photoA = await media(userA);
  photoB = await media(userB);
});

afterAll(async () => {
  await db.delete(schema.orders).where(inArray(schema.orders.authorId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

it("заказ B с фото A отклоняется (media_not_found), заказ не создаётся; со своим фото — создаётся", async () => {
  for (const ids of [[photoA], [photoB, photoA]]) {
    const res = await create(userB, ids);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("media_not_found");
  }
  expect(await db.select().from(schema.orders).where(eq(schema.orders.authorId, userB))).toEqual([]);
  const ok = await create(userB, [photoB]);
  expect(ok.statusCode).toBe(201);
  const linked = await db.select().from(schema.orderMedia).where(eq(schema.orderMedia.orderId, ok.json().orderId));
  expect(linked.map((r) => r.mediaId)).toEqual([photoB]);
});
