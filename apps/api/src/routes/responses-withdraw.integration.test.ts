import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import assignmentsRoutes from "./assignments.js";
import myRoutes from "./my.js";

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let author: string, exec1: string, exec2: string, orderId: string;

const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(responsesRoutes);
  await app.register(assignmentsRoutes);
  await app.register(myRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST withdraw", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityIds.push(city!.id);
  for (let i = 0; i < 3; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST w${i}`, cityId: city!.id, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [author, exec1, exec2] = userIds as [string, string, string];
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId: city!.id, sourceText: "TEST order", status: "published",
  }).returning();
  orderId = o!.id;
});

afterAll(async () => {
  await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const candidates = async () =>
  (await app.inject({ method: "GET", url: `/orders/${orderId}/responses`, headers: as(author) })).json().items as { id: string; executorId: string }[];
const activeCount = async () =>
  (await app.inject({ method: "GET", url: "/my/orders", headers: as(author) })).json().items.find((i: { id: string }) => i.id === orderId).activeResponsesCount as number;

it("withdraw before selection: status withdrawn, hidden from author, counter drops, row kept", async () => {
  const r1 = (await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec1), payload: { comment: "a" } })).json();
  await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec2), payload: { comment: "b" } });
  expect(await activeCount()).toBe(2);
  expect((await candidates()).length).toBe(2);

  const del = await app.inject({ method: "DELETE", url: `/responses/${r1.id}`, headers: as(exec1) });
  expect(del.statusCode).toBe(204);

  const row = await db.query.responses.findFirst({ where: eq(schema.responses.id, r1.id) });
  expect(row?.status).toBe("withdrawn");
  expect((await candidates()).map((c) => c.id)).not.toContain(r1.id);
  expect(await activeCount()).toBe(1);

  // повторный отзыв и выбор отозванного — запрещены
  expect((await app.inject({ method: "DELETE", url: `/responses/${r1.id}`, headers: as(exec1) })).statusCode).toBe(409);
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: r1.id } });
  expect(pick.statusCode).toBe(409);

  // можно откликнуться заново
  const again = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec1), payload: {} });
  expect(again.statusCode).toBe(201);
});

it("withdraw after selection is rejected and the response stays active", async () => {
  const mine = (await candidates()).find((c) => c.executorId === exec2)!;
  await db.insert(schema.orderAssignments).values({ orderId, executorId: exec2, responseId: mine.id });
  const del = await app.inject({ method: "DELETE", url: `/responses/${mine.id}`, headers: as(exec2) });
  expect(del.statusCode).toBe(409);
  expect(del.json().error.code).toBe("already_selected");
  expect((await db.query.responses.findFirst({ where: eq(schema.responses.id, mine.id) }))?.status).toBe("active");
});
