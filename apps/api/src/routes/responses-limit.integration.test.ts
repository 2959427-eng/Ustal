/**
 * Лимит откликов и «Достаточно откликов» (2026-10-15, @ustal/domain order-delivery): не более 150 активных откликов
 * на заказ даже при параллельных запросах; заказчик может остановить и возобновить приём; лента и карточка заказа
 * показывают, что приём закрыт, только тем, кто ещё не откликнулся.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { MAX_ACTIVE_RESPONSES } from "@ustal/domain";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import ordersRoutes from "./orders.js";
import feedRoutes from "./feed.js";
import orderViewRoutes from "./order-view.js";

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
let cityId: string, author: string;
const as = (user: string) => ({ "x-test-user": user });

async function newUsers(n: number) {
  const rows = await db.insert(schema.users).values(Array.from({ length: n }, () => ({ phone: randomUUID().slice(0, 20), passwordHash: "local-test", status: "active" }))).returning();
  await db.insert(schema.userProfiles).values(rows.map((u, i) => ({ userId: u.id, name: `TEST lim${i}`, cityId, acceptedPdnAt: new Date(), acceptedRulesAt: new Date() })));
  userIds.push(...rows.map((u) => u.id));
  return rows.map((u) => u.id);
}
async function newOrder() {
  const [o] = await db.insert(schema.orders).values({ authorId: author, cityId, sourceText: "TEST limit order", status: "published", publishedAt: new Date() }).returning();
  return o!.id;
}
/** Кандидаты подбора, чтобы заказ был в ленте этих пользователей (applied-профиль обязателен для ленты). */
async function deliver(orderId: string, users: string[]) {
  for (const userId of users) {
    const [cp] = await db.insert(schema.capabilityProfiles).values({ userId, summary: "TEST", profileVersion: 1, extractionVersion: "test", status: "applied" }).returning();
    void cp;
  }
  const [run] = await db.insert(schema.matchingRuns).values({ orderId, startedAt: new Date(Date.now() - 1000), completedAt: new Date(), candidatesCount: users.length }).returning();
  await db.insert(schema.matchingCandidates).values(users.map((userId) => ({ matchingRunId: run!.id, userId, score: "80", matchType: "exact", explanation: "TEST" })));
}
const respond = (orderId: string, user: string) => app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(user), payload: { comment: "TEST" } });
const feedIds = async (user: string) => ((await app.inject({ method: "GET", url: "/feed", headers: as(user) })).json().items as { orderId: string }[]).map((i) => i.orderId);

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => { request.userId = request.headers["x-test-user"] as string; });
  await app.register(responsesRoutes); await app.register(ordersRoutes); await app.register(feedRoutes); await app.register(orderViewRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({ name: "TEST limit " + randomUUID(), regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false }).returning();
  cityId = city!.id;
  [author] = await newUsers(1) as [string];
});
afterAll(async () => {
  await db.delete(schema.orders).where(eq(schema.orders.cityId, cityId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(eq(schema.cities.id, cityId));
  await app.close();
  await getSql().end();
});

it(`never more than ${MAX_ACTIVE_RESPONSES} active responses, even with parallel requests; a withdrawal frees a place`, async () => {
  const orderId = await newOrder();
  const early = await newUsers(MAX_ACTIVE_RESPONSES - 3);
  await db.insert(schema.responses).values(early.map((executorId) => ({ orderId, executorId })));
  const racers = await newUsers(20);
  const results = await Promise.all(racers.map((u) => respond(orderId, u)));
  expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
  const refused = results.filter((r) => r.statusCode === 409);
  expect(refused).toHaveLength(17);
  expect(refused.every((r) => r.json().error.code === "response_limit_reached")).toBe(true);
  const active = await db.query.responses.findMany({ where: eq(schema.responses.orderId, orderId) });
  expect(active.filter((r) => r.status === "active")).toHaveLength(MAX_ACTIVE_RESPONSES);

  const own = (await app.inject({ method: "GET", url: `/orders/${orderId}`, headers: as(author) })).json();
  expect(own).toMatchObject({ activeResponsesCount: MAX_ACTIVE_RESPONSES, responseLimit: MAX_ACTIVE_RESPONSES, responsesClosed: false, acceptingResponses: false, deliveryWave: 1 });
  const late = racers.find((u) => !active.some((r) => r.executorId === u))!;
  expect((await app.inject({ method: "GET", url: `/orders/${orderId}/view`, headers: as(late) })).json()).toMatchObject({ canRespond: false, acceptingResponses: false });

  // Отзыв отклика освобождает место.
  await db.update(schema.responses).set({ status: "withdrawn" }).where(eq(schema.responses.id, active[0]!.id));
  expect((await respond(orderId, late)).statusCode).toBe(201);
  expect((await respond(orderId, racers.find((u) => u !== late && !active.some((r) => r.executorId === u))!)).json().error.code).toBe("response_limit_reached");
}, 60_000);

it("«Достаточно откликов»: only the author; new responses refused; responders keep the order in the feed, others lose it; reopen restores", async () => {
  const orderId = await newOrder();
  const [responder, other, stranger] = await newUsers(3) as [string, string, string];
  await deliver(orderId, [responder, other]);
  expect((await respond(orderId, responder)).statusCode).toBe(201);
  expect(await feedIds(other)).toContain(orderId);

  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/responses/close`, headers: as(stranger) })).statusCode).toBe(404);
  const closed = await app.inject({ method: "POST", url: `/orders/${orderId}/responses/close`, headers: as(author) });
  expect(closed.json()).toMatchObject({ responsesClosed: true, activeResponsesCount: 1, acceptingResponses: false });
  // Повтор — тот же результат (идемпотентно), время закрытия не сдвигается.
  const closedAt = (await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))!.responsesClosedAt;
  await app.inject({ method: "POST", url: `/orders/${orderId}/responses/close`, headers: as(author) });
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))!.responsesClosedAt).toEqual(closedAt);

  const refused = await respond(orderId, other);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe("responses_closed");
  expect(await feedIds(other)).not.toContain(orderId);
  expect(await feedIds(responder)).toContain(orderId);
  expect((await app.inject({ method: "GET", url: `/orders/${orderId}/view`, headers: as(other) })).json()).toMatchObject({ canRespond: false, acceptingResponses: false });

  const reopened = await app.inject({ method: "POST", url: `/orders/${orderId}/responses/reopen`, headers: as(author) });
  expect(reopened.json()).toMatchObject({ responsesClosed: false, acceptingResponses: true });
  expect(await feedIds(other)).toContain(orderId);
  expect((await respond(orderId, other)).statusCode).toBe(201);

  // В закрытом заказе приём не меняется.
  await db.update(schema.orders).set({ status: "closed" }).where(eq(schema.orders.id, orderId));
  expect((await app.inject({ method: "POST", url: `/orders/${orderId}/responses/close`, headers: as(author) })).statusCode).toBe(409);
}, 60_000);
