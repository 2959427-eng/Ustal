import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, it, expect } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import {
  assertLocalTestDatabase,
  getDb,
  getSql,
  schema,
} from "@ustal/database";
import feedRoutes from "./feed.js";
import profileRoutes from "./profile.js";

assertLocalTestDatabase();
const db = getDb(),
  app = Fastify();
const users: string[] = [],
  cities: string[] = [];
let executor: string, author: string, orderId: string, profileId: string;
beforeAll(async () => {
  for (const name of ["TEST feed A", "TEST feed B"]) {
    const [c] = await db
      .insert(schema.cities)
      .values({
        name,
        regionName: "TEST",
        federalDistrict: "TEST",
        timezone: "Asia/Vladivostok",
        isActive: false,
      })
      .returning();
    cities.push(c!.id);
  }
  for (let i = 0; i < 2; i++) {
    const [u] = await db
      .insert(schema.users)
      .values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" })
      .returning();
    users.push(u!.id);
    await db
      .insert(schema.userProfiles)
      .values({
        userId: u!.id,
        name: "TEST feed",
        cityId: cities[0]!,
        acceptedPdnAt: new Date(),
        acceptedRulesAt: new Date(),
      });
  }
  [author, executor] = users as [string, string];
  const [p] = await db
    .insert(schema.capabilityProfiles)
    .values({
      userId: executor,
      summary: "confirmed skill",
      profileVersion: 1,
      extractionVersion: "test",
      status: "applied",
    })
    .returning();
  profileId = p!.id;
  const [o] = await db
    .insert(schema.orders)
    .values({
      authorId: author,
      cityId: cities[0]!,
      normalizedTitle: "TEST feed order",
      status: "published",
    })
    .returning();
  orderId = o!.id;
  const [r] = await db
    .insert(schema.matchingRuns)
    .values({
      orderId,
      startedAt: new Date(Date.now() - 10000),
      completedAt: new Date(),
      candidatesCount: 1,
    })
    .returning();
  await db
    .insert(schema.matchingCandidates)
    .values({
      matchingRunId: r!.id,
      userId: executor,
      score: "80",
      matchType: "exact",
      explanation: "test",
    });
  app.decorate(
    "authenticate",
    async (request: import("fastify").FastifyRequest) => {
      request.userId = executor;
    },
  );
  await app.register(feedRoutes);
  await app.register(profileRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (orderId)
    await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
  if (users.length)
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (cities.length)
    await db.delete(schema.cities).where(inArray(schema.cities.id, cities));
  await getSql().end();
});
const feed = async () => {
  const r = await app.inject({ method: "GET", url: "/feed" });
  expect(r.statusCode).toBe(200);
  return r.json().items as { orderId: string }[];
};
it("serves a completed match and ignores an unfinished newer run", async () => {
  await db
    .insert(schema.matchingRuns)
    .values({ orderId, startedAt: new Date() });
  expect((await feed()).some((o) => o.orderId === orderId)).toBe(true);
});
it("rechecks city and blocks at read time", async () => {
  await db
    .update(schema.userProfiles)
    .set({ cityId: cities[1] })
    .where(eq(schema.userProfiles.userId, executor));
  expect(await feed()).toEqual([]);
  await db
    .update(schema.userProfiles)
    .set({ cityId: cities[0] })
    .where(eq(schema.userProfiles.userId, executor));
  const [b] = await db
    .insert(schema.blocks)
    .values({ blockerId: executor, blockedId: author })
    .returning();
  expect(await feed()).toEqual([]);
  await db.delete(schema.blocks).where(eq(schema.blocks.id, b!.id));
});
it("real profile apply writes a durable event and invalidates old feed rows", async () => {
  const [draft] = await db
    .insert(schema.capabilityProfiles)
    .values({
      userId: executor,
      summary: "new preferences",
      profileVersion: 2,
      extractionVersion: "test",
      status: "draft",
    })
    .returning();
  const r = await app.inject({
    method: "POST",
    url: `/profile/draft/${draft!.id}/apply`,
  });
  expect(r.statusCode).toBe(200);
  expect(
    (
      await db.query.capabilityProfiles.findFirst({
        where: eq(schema.capabilityProfiles.id, profileId),
      })
    )?.status,
  ).toBe("superseded");
  expect(
    await db.query.rematchRequests.findFirst({
      where: eq(schema.rematchRequests.userId, executor),
    }),
  ).toBeDefined();
  expect(await feed()).toEqual([]);
  await db.update(schema.rematchRequests).set({cursor:"ffffffff-ffff-ffff-ffff-ffffffffffff"}).where(eq(schema.rematchRequests.userId,executor));
  expect(await feed()).toEqual([]); // Dispatch complete is not matching complete.
});
