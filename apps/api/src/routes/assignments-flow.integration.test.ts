import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, inArray } from "drizzle-orm";
import { assertLocalTestDatabase, getDb, getSql, schema } from "@ustal/database";
import responsesRoutes from "./responses.js";
import contactsRoutes from "./contacts.js";
import assignmentsRoutes from "./assignments.js";

// Уведомления ставят задачи в pg-boss — в интеграционном тесте они не нужны.
vi.mock("../lib/notify.js", () => ({ notifyUser: vi.fn(async () => "n") }));

assertLocalTestDatabase();
const db = getDb();
const app = Fastify();
const userIds: string[] = [];
const cityIds: string[] = [];
let author: string, exec: string, orderId: string, responseId: string;

const as = (user: string) => ({ "x-test-user": user });

beforeAll(async () => {
  app.decorate("authenticate", async (request: import("fastify").FastifyRequest) => {
    request.userId = request.headers["x-test-user"] as string;
  });
  await app.register(responsesRoutes);
  await app.register(contactsRoutes);
  await app.register(assignmentsRoutes);
  await app.ready();
  const [city] = await db.insert(schema.cities).values({
    name: "TEST flow", regionName: "TEST", federalDistrict: "TEST", timezone: "Asia/Vladivostok", isActive: false,
  }).returning();
  cityIds.push(city!.id);
  for (let i = 0; i < 2; i++) {
    const [u] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
    userIds.push(u!.id);
    await db.insert(schema.userProfiles).values({
      userId: u!.id, name: `TEST f${i}`, cityId: city!.id, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
    });
  }
  [author, exec] = userIds as [string, string];
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId: city!.id, sourceText: "TEST order", status: "published",
  }).returning();
  orderId = o!.id;
});

afterAll(async () => {
  await db.delete(schema.orders).where(eq(schema.orders.authorId, author));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.cities).where(inArray(schema.cities.id, cityIds));
  await app.close();
  await getSql().end();
});

const orderStatus = async () => (await db.query.orders.findFirst({ where: eq(schema.orders.id, orderId) }))?.status;

it("MVP flow: select = negotiating (one executor, cancellable); start = in_progress closes the order; complete = completed", async () => {
  // третий участник — второй исполнитель
  const [u2] = await db.insert(schema.users).values({ phone: randomUUID().slice(0, 20), passwordHash: "local-test" }).returning();
  userIds.push(u2!.id);
  await db.insert(schema.userProfiles).values({
    userId: u2!.id, name: "TEST f2", cityId: cityIds[0]!, acceptedPdnAt: new Date(), acceptedRulesAt: new Date(),
  });
  const exec2 = u2!.id;

  const created = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec), payload: {} });
  responseId = created.json().id;
  const created2 = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec2), payload: {} });
  const response2Id = created2.json().id as string;
  for (const rid of [responseId, response2Id]) {
    const unlock = await app.inject({ method: "POST", url: `/orders/${orderId}/contact-unlocks`, headers: as(author), payload: { responseId: rid } });
    expect([200, 201]).toContain(unlock.statusCode);
  }

  // 2. выбор = «Идут переговоры»
  const pick = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId } });
  expect(pick.statusCode).toBe(201);
  const assignmentId = pick.json().id as string;
  expect(pick.json().status).toBe("selected");
  expect(await orderStatus()).toBe("negotiating");

  // ЭТАП 2 переговоров (2026-09-22): MVP под одного исполнителя снят — можно
  // выбрать нескольких кандидатов одновременно, оба остаются "selected", пока
  // никто не сказал «Договорились» (см. negotiation-architecture-audit).
  const second = await app.inject({ method: "POST", url: `/orders/${orderId}/assignments`, headers: as(author), payload: { responseId: response2Id } });
  expect(second.statusCode).toBe(201);
  expect(second.json().status).toBe("selected");
  const assignment2 = second.json().id as string;
  expect(await orderStatus()).toBe("negotiating");

  // «Выполнено / Не выполнено» до «Договорились» недоступны
  const base = `/orders/${orderId}/assignments/${assignmentId}`;
  expect((await app.inject({ method: "POST", url: `${base}/complete`, headers: as(author), payload: {} })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: `${base}/not-completed`, headers: as(author), payload: {} })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: `${base}/start`, headers: as(exec), payload: {} })).statusCode).toBe(404);

  // отмена выбора первого кандидата: второй (exec2) остаётся "selected", поэтому
  // заказ ОСТАЁТСЯ "negotiating" (не откатывается в "published"), закрывается
  // только контакт отменённого кандидата — у второго контакт не трогается
  const cancel = await app.inject({ method: "POST", url: `${base}/cancel`, headers: as(author), payload: {} });
  expect(cancel.statusCode).toBe(200);
  expect(await orderStatus()).toBe("negotiating");
  expect((await db.query.contactUnlocks.findMany({ where: eq(schema.contactUnlocks.executorId, exec) })).length).toBe(0);
  expect((await db.query.contactUnlocks.findMany({ where: eq(schema.contactUnlocks.executorId, exec2) })).length).toBe(1);

  // 3. «Договорились» = «В работе»: заказ закрыт для остальных, отклик первого → not_selected, новые отклики запрещены
  const base2 = `/orders/${orderId}/assignments/${assignment2}`;
  const start = await app.inject({ method: "POST", url: `${base2}/start`, headers: as(author), payload: {} });
  expect(start.statusCode).toBe(200);
  expect(start.json().status).toBe("in_progress");
  expect(await orderStatus()).toBe("in_progress");
  expect((await db.query.responses.findFirst({ where: eq(schema.responses.id, responseId) }))?.status).toBe("not_selected");
  expect((await app.inject({ method: "POST", url: `${base2}/start`, headers: as(author), payload: {} })).statusCode).toBe(409);
  const late = await app.inject({ method: "POST", url: `/orders/${orderId}/responses`, headers: as(exec), payload: {} });
  expect(late.statusCode).toBe(409);
  // после «В работе» отменить выбор нельзя
  expect((await app.inject({ method: "POST", url: `${base2}/cancel`, headers: as(author), payload: {} })).statusCode).toBe(409);

  // 4. «Выполнено» → заказ «Выполнен»
  const done = await app.inject({ method: "POST", url: `${base2}/complete`, headers: as(author), payload: {} });
  expect(done.statusCode).toBe(200);
  expect(done.json().status).toBe("completed");
  expect(await orderStatus()).toBe("completed");
});

it("not-completed finishes the order as not_completed", async () => {
  const [o] = await db.insert(schema.orders).values({
    authorId: author, cityId: cityIds[0]!, sourceText: "TEST order 2", status: "published",
  }).returning();
  const oid = o!.id;
  const created = await app.inject({ method: "POST", url: `/orders/${oid}/responses`, headers: as(exec), payload: {} });
  const rid = created.json().id as string;
  await app.inject({ method: "POST", url: `/orders/${oid}/contact-unlocks`, headers: as(author), payload: { responseId: rid } });
  const pick = await app.inject({ method: "POST", url: `/orders/${oid}/assignments`, headers: as(author), payload: { responseId: rid } });
  const base = `/orders/${oid}/assignments/${pick.json().id}`;
  await app.inject({ method: "POST", url: `${base}/start`, headers: as(author), payload: {} });
  const nc = await app.inject({ method: "POST", url: `${base}/not-completed`, headers: as(author), payload: {} });
  expect(nc.statusCode).toBe(200);
  expect((await db.query.orders.findFirst({ where: eq(schema.orders.id, oid) }))?.status).toBe("not_completed");
});
